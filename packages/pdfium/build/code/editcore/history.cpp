#include "ec_internal.h"
#include "fpdf_transformpage.h"

#include <cstring>
#include <cmath>

namespace ec {
namespace {

int objectIndex(FPDF_PAGE page, FPDF_PAGEOBJECT container, FPDF_PAGEOBJECT obj) {
    if (container) {
        const int n = FPDFFormObj_CountObjects(container);
        for (int i = 0; i < n; i++)
            if (FPDFFormObj_GetObject(container, static_cast<unsigned long>(i)) == obj)
                return i;
        return -1;
    }
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++)
        if (FPDFPage_GetObject(page, i) == obj) return i;
    return -1;
}

bool stackReferences(const Session& s, FPDF_PAGEOBJECT obj) {
    for (const std::vector<EditCommand>* st : {&s.undoStack, &s.redoStack})
        for (const EditCommand& c : *st)
            for (const EditOp& op : c.ops)
                if (op.object == obj) return true;
    return false;
}

void insertAt(FPDF_PAGE page, FPDF_PAGEOBJECT obj, int index) {
    const int n = FPDFPage_CountObjects(page);
    if (index >= 0 && index <= n &&
        FPDFPage_InsertObjectAtIndex(page, obj, static_cast<size_t>(index))) {
        return;
    }
    FPDFPage_InsertObject(page, obj);
}

void releaseOps(std::vector<EditOp>& ops) {
    for (EditOp& op : ops) {
        if (op.owned && op.object) FPDFPageObj_Destroy(op.object);
        op.owned = false;
        op.object = nullptr;
    }
}

void releaseStack(std::vector<EditCommand>& stack) {
    for (EditCommand& c : stack) releaseOps(c.ops);
    stack.clear();
}

FS_MATRIX matMul(const FS_MATRIX& m, const FS_MATRIX& r) {
    return FS_MATRIX{m.a * r.a + m.b * r.c,
                     m.a * r.b + m.b * r.d,
                     m.c * r.a + m.d * r.c,
                     m.c * r.b + m.d * r.d,
                     m.e * r.a + m.f * r.c + r.e,
                     m.e * r.b + m.f * r.d + r.f};
}

bool matInvert(const FS_MATRIX& m, FS_MATRIX* out) {
    const float det = m.a * m.d - m.b * m.c;
    if (std::abs(det) < 1e-9f) return false;
    out->a = m.d / det;
    out->b = -m.b / det;
    out->c = -m.c / det;
    out->d = m.a / det;
    out->e = (m.c * m.f - m.d * m.e) / det;
    out->f = (m.b * m.e - m.a * m.f) / det;
    return true;
}

bool relativeStep(const FS_MATRIX& before, const FS_MATRIX& after, FS_MATRIX* out) {
    FS_MATRIX inv;
    if (!matInvert(before, &inv)) return false;
    *out = matMul(inv, after);
    return true;
}

void reorderTo(FPDF_PAGE page, FPDF_PAGEOBJECT obj, int index) {
    if (index < 0) return;
    if (!FPDFPage_RemoveObject(page, obj)) return;
    insertAt(page, obj, index);
}

bool applyOp(EditOp& op, FPDF_PAGE page, bool forward) {
    const bool doInsert = (op.kind == EditOp::Kind::Insert) == forward;
    switch (op.kind) {
        case EditOp::Kind::Matrix: {

            FS_MATRIX step;
            if (relativeStep(op.before, op.after, &step)) {
                if (forward) {
                    FPDFPageObj_TransformClipPath(op.object, step.a, step.b, step.c,
                                                  step.d, step.e, step.f);
                } else {
                    FS_MATRIX back;
                    if (matInvert(step, &back)) {
                        FPDFPageObj_TransformClipPath(op.object, back.a, back.b, back.c,
                                                      back.d, back.e, back.f);
                    }
                }
            }
            FS_MATRIX m = forward ? op.after : op.before;
            return FPDFPageObj_SetMatrix(op.object, &m) != 0;
        }
        case EditOp::Kind::ZOrder: {
            reorderTo(page, op.object, forward ? static_cast<int>(op.dx)
                                               : op.index);
            return true;
        }
        case EditOp::Kind::Move: {
            const float dx = forward ? op.dx : -op.dx;
            const float dy = forward ? op.dy : -op.dy;
            FS_MATRIX m{1, 0, 0, 1, dx, dy};
            return FPDFPageObj_TransformF(op.object, &m) != 0;
        }
        case EditOp::Kind::Charcodes: {
            const std::vector<uint32_t>& codes = forward ? op.codesAfter : op.codesBefore;
            const std::vector<float>& pos = forward ? op.posAfter : op.posBefore;
            if (!FPDFText_SetCharcodes(op.object, codes.data(), codes.size()))
                return false;

            if (pos.size() >= 2)
                FPDFText_SetPositions(op.object, pos.data() + 1, pos.size() - 1);
            return true;
        }
        case EditOp::Kind::Insert:
        case EditOp::Kind::Remove: {
            if (doInsert) {
                if (!op.owned) return false;
                if (op.container) {

                    return false;
                }
                insertAt(page, op.object, op.index);
                op.owned = false;
                return true;
            }
            const bool removed = op.container
                ? FPDFFormObj_RemoveObject(op.container, op.object) != 0
                : FPDFPage_RemoveObject(page, op.object) != 0;
            if (removed) op.owned = true;
            return removed;
        }
    }
    return false;
}

}

bool historyRecording(const Session& s) { return s.recording != nullptr; }

void historyBegin(Session& s, FPDF_PAGE page, const char* label) {
    if (s.recording) {
        if (s.recording->label == "__live_preview__" &&
            (!label || strcmp(label, "__live_preview__") != 0)) {
            historyScratchRevert(s, s.recording->page);
            s.livePage = nullptr;
            s.livePara = -1;
            s.liveTicks = 0;
        } else {
            return;
        }
    }
    if (s.recording) return;
    auto it = s.pages.find(page);
    s.recording = std::make_unique<EditCommand>();
    s.recording->page = page;
    s.recording->label = label ? label : "";
    s.recording->nextParaIdBefore = s.nextParaId;
    if (it != s.pages.end()) s.recording->before = it->second.paras;
}

void historyAbort(Session& s) {
    if (!s.recording) return;

    releaseOps(s.recording->ops);
    s.recording.reset();
}

void historyEnd(Session& s, FPDF_PAGE page) {
    if (!s.recording) return;
    historySealNotes(s, page);
    std::unique_ptr<EditCommand> cmd = std::move(s.recording);
    if (cmd->ops.empty()) return;

    cmd->ops.erase(std::remove_if(cmd->ops.begin(), cmd->ops.end(), [](const EditOp& op) {
        if (op.kind == EditOp::Kind::Matrix)
            return memcmp(&op.before, &op.after, sizeof(FS_MATRIX)) == 0;
        if (op.kind == EditOp::Kind::Charcodes)
            return op.codesBefore == op.codesAfter && op.posBefore == op.posAfter;
        if (op.kind == EditOp::Kind::ZOrder)
            return static_cast<int>(op.dx) == op.index;
        return false;
    }), cmd->ops.end());
    if (cmd->ops.empty()) return;
    auto it = s.pages.find(page);
    if (it != s.pages.end()) cmd->after = it->second.paras;
    cmd->nextParaIdAfter = s.nextParaId;
    releaseStack(s.redoStack);
    s.undoStack.push_back(std::move(*cmd));
    while (s.undoStack.size() > s.historyLimit) {
        releaseOps(s.undoStack.front().ops);
        s.undoStack.erase(s.undoStack.begin());
    }
}

void historyDropPage(Session& s, FPDF_PAGE page) {
    if (s.recording && s.recording->page == page) historyAbort(s);
    for (std::vector<EditCommand>* st : {&s.undoStack, &s.redoStack}) {
        for (auto it = st->begin(); it != st->end();) {
            if (it->page == page) {
                releaseOps(it->ops);
                it = st->erase(it);
            } else {
                ++it;
            }
        }
    }
}

namespace {
void dropCommandsUsing(Session& s, FPDF_PAGEOBJECT obj) {
    for (std::vector<EditCommand>* st : {&s.undoStack, &s.redoStack}) {
        for (auto it = st->begin(); it != st->end();) {
            bool uses = false;
            for (const EditOp& op : it->ops)
                if (op.object == obj) { uses = true; break; }
            if (uses) {
                releaseOps(it->ops);
                it = st->erase(it);
            } else {
                ++it;
            }
        }
    }
}
}

bool historyRemoveObject(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT container,
                         FPDF_PAGEOBJECT obj) {
    if (!obj) return false;
    const int index = objectIndex(page, container, obj);
    const bool removed = container
        ? FPDFFormObj_RemoveObject(container, obj) != 0
        : FPDFPage_RemoveObject(page, obj) != 0;
    if (!removed) return false;
    if (s.recording && !container) {
        EditOp op;
        op.kind = EditOp::Kind::Remove;
        op.object = obj;
        op.container = nullptr;
        op.index = index;
        op.owned = true;
        s.recording->ops.push_back(op);
        return true;
    }
    if (s.recording && container) {

        historyAbort(s);
    }

    if (stackReferences(s, obj)) dropCommandsUsing(s, obj);
    FPDFPageObj_Destroy(obj);
    return true;
}

void historyInsertObject(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj, int index) {
    if (!obj) return;
    insertAt(page, obj, index);
    if (!s.recording) return;
    EditOp op;
    op.kind = EditOp::Kind::Insert;
    op.object = obj;
    op.index = index >= 0 ? index : objectIndex(page, nullptr, obj);
    s.recording->ops.push_back(op);
}

void historyNoteMatrix(Session& s, FPDF_PAGEOBJECT obj) {
    if (!s.recording || !obj) return;
    EditOp op;
    op.kind = EditOp::Kind::Matrix;
    op.object = obj;
    if (!FPDFPageObj_GetMatrix(obj, &op.before)) return;
    op.after = op.before;
    s.recording->ops.push_back(op);
}

void historyNoteZOrder(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    if (!s.recording || !obj) return;
    EditOp op;
    op.kind = EditOp::Kind::ZOrder;
    op.object = obj;
    op.index = objectIndex(page, nullptr, obj);
    op.dx = static_cast<float>(op.index);
    if (op.index < 0) return;
    s.recording->ops.push_back(op);
}

void historyNoteInsert(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    if (!s.recording || !obj) return;
    EditOp op;
    op.kind = EditOp::Kind::Insert;
    op.object = obj;
    op.index = objectIndex(page, nullptr, obj);
    s.recording->ops.push_back(op);
}

void historySealNotes(Session& s, FPDF_PAGE page) {
    if (!s.recording) return;

    auto& ops = s.recording->ops;
    for (EditOp& op : ops) {
        if (op.kind != EditOp::Kind::Matrix && op.kind != EditOp::Kind::ZOrder)
            continue;
        if (objectIndex(page, op.container, op.object) < 0) {
            op.object = nullptr;
            continue;
        }
        if (op.kind == EditOp::Kind::Matrix) {
            FPDFPageObj_GetMatrix(op.object, &op.after);
        } else {
            op.dx = static_cast<float>(objectIndex(page, nullptr, op.object));
        }
    }
    ops.erase(std::remove_if(ops.begin(), ops.end(), [](const EditOp& op) {
                  return (op.kind == EditOp::Kind::Matrix ||
                          op.kind == EditOp::Kind::ZOrder) && !op.object;
              }),
              ops.end());
}

void historyRecordMove(Session& s, FPDF_PAGEOBJECT obj, float dx, float dy) {
    if (!s.recording || !obj) return;
    if (dx == 0 && dy == 0) return;
    EditOp op;
    op.kind = EditOp::Kind::Move;
    op.object = obj;
    op.dx = dx;
    op.dy = dy;
    s.recording->ops.push_back(op);
}

namespace {

enum class OpState { Apply, Skip, Unsafe };

OpState opState(const EditOp& op, FPDF_PAGE page, bool forward) {
    if (!op.object) return OpState::Apply;
    const bool onPage = objectIndex(page, op.container, op.object) >= 0;
    switch (op.kind) {
        case EditOp::Kind::Insert:

            if (!forward) return onPage ? OpState::Apply : OpState::Skip;
            return onPage ? OpState::Skip : OpState::Apply;
        case EditOp::Kind::Remove:

            if (!forward) return onPage ? OpState::Unsafe : OpState::Apply;
            return onPage ? OpState::Apply : OpState::Skip;
        case EditOp::Kind::Move:
        case EditOp::Kind::Matrix:
        case EditOp::Kind::ZOrder:
        case EditOp::Kind::Charcodes:
            return onPage ? OpState::Apply : OpState::Skip;
    }
    return OpState::Apply;
}

bool stepIsSafe(const EditCommand& cmd, FPDF_PAGE page, bool forward) {
    for (const EditOp& op : cmd.ops)
        if (opState(op, page, forward) == OpState::Unsafe) return false;
    return true;
}

bool applyStep(Session& s, FPDF_PAGE page, std::vector<EditCommand>& from,
               std::vector<EditCommand>& to, bool forward) {
    if (from.empty()) return false;

    if (from.back().page != page) return false;
    EditCommand cmd = std::move(from.back());
    from.pop_back();
    if (!stepIsSafe(cmd, page, forward)) {

        releaseOps(cmd.ops);
        releaseStack(from);
        releaseStack(to);
        return false;
    }
    if (forward) {
        for (size_t i = 0; i < cmd.ops.size(); i++)
            if (opState(cmd.ops[i], page, true) == OpState::Apply)
                applyOp(cmd.ops[i], page, true);
    } else {
        for (size_t i = cmd.ops.size(); i-- > 0;)
            if (opState(cmd.ops[i], page, false) == OpState::Apply)
                applyOp(cmd.ops[i], page, false);
    }
    auto it = s.pages.find(page);
    if (it != s.pages.end()) {
        it->second.paras = forward ? cmd.after : cmd.before;
        s.nextParaId = forward ? cmd.nextParaIdAfter : cmd.nextParaIdBefore;
    }
    to.push_back(std::move(cmd));
    return true;
}
}

bool historyUndo(Session& s, FPDF_PAGE page) {
    return applyStep(s, page, s.undoStack, s.redoStack,  false);
}

bool historyRedo(Session& s, FPDF_PAGE page) {
    return applyStep(s, page, s.redoStack, s.undoStack,  true);
}

FPDF_PAGE historyNextPage(const Session& s, int which) {
    const std::vector<EditCommand>& st = which ? s.redoStack : s.undoStack;
    return st.empty() ? nullptr : st.back().page;
}

void historyClear(Session& s) {
    historyAbort(s);
    releaseStack(s.undoStack);
    releaseStack(s.redoStack);
}

bool historyScratchRevert(Session& s, FPDF_PAGE page) {
    if (!s.recording) return false;
    historySealNotes(s, page);
    std::unique_ptr<EditCommand> cmd = std::move(s.recording);
    if (cmd->page != page) {
        releaseOps(cmd->ops);
        return false;
    }
    for (size_t i = cmd->ops.size(); i-- > 0;) {
        if (opState(cmd->ops[i], page,  false) == OpState::Apply)
            applyOp(cmd->ops[i], page,  false);
    }
    auto it = s.pages.find(page);
    if (it != s.pages.end()) {
        it->second.paras = cmd->before;
        s.nextParaId = cmd->nextParaIdBefore;
    }

    releaseOps(cmd->ops);
    return true;
}

}


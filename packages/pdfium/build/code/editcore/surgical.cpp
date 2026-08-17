#include "ec_internal.h"
#include "pdfium_internal.h"

namespace ec {

namespace {

#define EC_SBAIL(why)                                                     \
    do {                                                                  \
        if (getenv("EC_SURGICAL_DEBUG"))                                  \
            fprintf(stderr, "[surgical] bail: %s\n", why);                \
        return false;                                                     \
    } while (0)

struct SText {
    FPDF_PAGEOBJECT obj = nullptr;
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    float size = 12.0f;
    FPDF_FONT font = nullptr;
    std::u16string text;

    std::vector<float> tx;

    std::vector<int> t2g;
    std::vector<OrigGlyph> g;
    int line = -1;
    bool preserved = false;
    bool sealed = false;
    bool shared = false;
    float x0 = 0, x1 = 0;
};

struct SLine {
    std::vector<int> texts;
    float baseline = 0;
    float penX = 0;
};

bool isCjk(char16_t c) {
    return (c >= 0x1100 && c <= 0x11FF) || (c >= 0x2E80 && c <= 0x9FFF) ||
           (c >= 0xA000 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7AF) ||
           (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF);
}

bool isWs(char16_t c) {
    return c == u' ' || c == u'\t' || c == 0x00A0 || c == 0x3000;
}

float nomAdv(FPDF_FONT font, uint32_t cp, float size) {
    float w = 0;
    if (font && FPDFFont_GetGlyphWidth(font, cp, size, &w) && w > 0) return w;
    return -1;
}

float docAdv(const std::vector<SText>& pool, FPDF_FONT font, float size,
             uint32_t code, char16_t unicode) {
    float best = -1;
    for (const SText& t : pool) {
        if (t.font != font || t.preserved || t.sealed) continue;
        if (std::abs(t.size - size) > 0.01f) continue;
        for (size_t k = 0; k + 1 < t.g.size(); k++)
            if (t.g[k].code == code) {
                const float d = t.g[k + 1].x - t.g[k].x;
                if (d > 0 && (best < 0 || d < best)) best = d;
            }
    }
    const float nom = nomAdv(font, unicode, size);
    if (best > 0 && nom > 0 && best > 1.4f * nom) best = nom;
    if (best > 0) return best;
    return nom;
}

float cidAdv(Session& s, FPDF_FONT font, float size, uint32_t code) {
    FPDF_PAGEOBJECT tw = FPDFPageObj_CreateTextObj(s.doc, font, size);
    if (!tw) return -1;
    const uint32_t codes[2] = {code, code};
    float adv = -1;
    if (FPDFText_SetCharcodes(tw, codes, 2)) {
        const std::vector<OrigGlyph> g2 = readOrigGlyphs(tw);
        if (g2.size() == 2 && g2[1].x > g2[0].x) adv = g2[1].x - g2[0].x;
    }
    FPDFPageObj_Destroy(tw);
    return adv;
}

bool sameStyle(const RunStyle& a, const RunStyle& b) {
    return a.family == b.family && a.bold == b.bold && a.italic == b.italic &&
           std::abs(a.size - b.size) < 0.01f && a.rgba == b.rgba &&
           a.underline == b.underline && a.strike == b.strike &&
           a.script == b.script && a.renderMode == b.renderMode &&
           a.strokeRgba == b.strokeRgba &&
           std::abs(a.strokeWidth - b.strokeWidth) < 0.01f &&
           std::abs(a.hScale - b.hScale) < 0.001f &&
           std::abs(a.rise - b.rise) < 0.01f &&
           a.fauxBold == b.fauxBold && a.fauxItalic == b.fauxItalic;
}

bool nearlyEq(float a, float b) { return std::abs(a - b) < 0.01f; }

void translatePage(Session& s, SText& t, float dxPage, float dyPage) {
    if (dxPage == 0 && dyPage == 0) return;
    EditOp op;
    op.kind = EditOp::Kind::Matrix;
    op.object = t.obj;
    op.before = t.m;
    t.m.e += dxPage;
    t.m.f += dyPage;
    op.after = t.m;
    FPDFPageObj_SetMatrix(t.obj, &t.m);
    if (s.recording) s.recording->ops.push_back(op);
    t.x0 += dxPage;
    t.x1 += dxPage;
}

bool applyCodes(Session& s, SText& t, const std::vector<OrigGlyph>& next) {
    std::vector<OrigGlyph> adj = next;
    const float base = adj.empty() ? 0.0f : adj.front().x;
    if (base != 0) {
        for (OrigGlyph& g : adj) g.x -= base;
        EditOp mop;
        mop.kind = EditOp::Kind::Matrix;
        mop.object = t.obj;
        mop.before = t.m;
        t.m.e += base * t.m.a;
        mop.after = t.m;
        FPDFPageObj_SetMatrix(t.obj, &t.m);
        if (s.recording) s.recording->ops.push_back(mop);
    }
    EditOp op;
    op.kind = EditOp::Kind::Charcodes;
    op.object = t.obj;
    op.codesBefore.reserve(t.g.size());
    op.posBefore.reserve(t.g.size());
    for (const OrigGlyph& g : t.g) {
        op.codesBefore.push_back(g.code);
        op.posBefore.push_back(g.x);
    }
    std::vector<uint32_t> codes;
    std::vector<float> pos;
    codes.reserve(adj.size());
    pos.reserve(adj.size());
    for (const OrigGlyph& g : adj) {
        codes.push_back(g.code);
        pos.push_back(g.x);
    }
    if (!FPDFText_SetCharcodes(t.obj, codes.data(), codes.size())) return false;

    if (pos.size() >= 2 &&
        !FPDFText_SetPositions(t.obj, pos.data() + 1, pos.size() - 1))
        return false;
    op.codesAfter = codes;
    op.posAfter = pos;
    if (s.recording) s.recording->ops.push_back(op);
    t.g = adj;
    return true;
}

int splitText(Session& s, FPDF_PAGE page, std::vector<SText>& pool, int ti, size_t chr) {
    SText& t0 = pool[static_cast<size_t>(ti)];
    if (chr == 0 || chr >= t0.g.size()) return -1;
    const float xTailText = t0.g[chr].x;
    SText tail;
    tail.font = t0.font;
    tail.size = t0.size;
    tail.line = t0.line;
    tail.obj = FPDFPageObj_CreateTextObj(s.doc, t0.font, t0.size);
    if (!tail.obj) return -1;
    tail.text = t0.text.substr(chr);
    tail.g.assign(t0.g.begin() + static_cast<long>(chr), t0.g.end());
    for (OrigGlyph& g : tail.g) g.x -= xTailText;
    {
        std::vector<uint32_t> codes;
        std::vector<float> pos;
        for (const OrigGlyph& g : tail.g) { codes.push_back(g.code); pos.push_back(g.x); }
        if (!FPDFText_SetCharcodes(tail.obj, codes.data(), codes.size())) {
            FPDFPageObj_Destroy(tail.obj);
            return -1;
        }

        if (pos.size() >= 2 &&
            !FPDFText_SetPositions(tail.obj, pos.data() + 1, pos.size() - 1)) {
            FPDFPageObj_Destroy(tail.obj);
            return -1;
        }
    }
    tail.m = t0.m;
    tail.m.e = t0.m.e + xTailText * t0.m.a;
    FPDFPageObj_SetMatrix(tail.obj, &tail.m);
    unsigned int r = 0, g2 = 0, b = 0, a2 = 255;
    if (FPDFPageObj_GetFillColor(t0.obj, &r, &g2, &b, &a2))
        FPDFPageObj_SetFillColor(tail.obj, r, g2, b, a2);
    unsigned int sr = 0, sg = 0, sb = 0, sa = 255;
    if (FPDFPageObj_GetStrokeColor(t0.obj, &sr, &sg, &sb, &sa))
        FPDFPageObj_SetStrokeColor(tail.obj, sr, sg, sb, sa);
    float sw = 0;
    if (FPDFPageObj_GetStrokeWidth(t0.obj, &sw) && sw > 0)
        FPDFPageObj_SetStrokeWidth(tail.obj, sw);
    FPDFTextObj_SetTextRenderMode(tail.obj, FPDFTextObj_GetTextRenderMode(t0.obj));

    int at = -1;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++)
        if (FPDFPage_GetObject(page, i) == t0.obj) { at = i + 1; break; }
    historyInsertObject(s, page, tail.obj, at);
    tail.x1 = t0.x1;
    tail.x0 = tail.m.e;

    std::vector<OrigGlyph> head(t0.g.begin(), t0.g.begin() + static_cast<long>(chr));
    const std::u16string headText = t0.text.substr(0, chr);
    if (!applyCodes(s, t0, head)) return -1;
    t0.text = headText;

    t0.x1 = tail.x0;
    pool.push_back(std::move(tail));
    return static_cast<int>(pool.size()) - 1;
}

struct WordCut { int t = -1; int c = -1; };

bool isBoundary(const SText& t, size_t ci) {
    if (ci >= t.text.size()) return false;
    const char16_t ch = t.text[ci];
    return isWs(ch) || isCjk(ch);
}

bool movableFromEnd(const std::vector<SText>& pool, const SLine& ln,
                    float limitX, WordCut* out) {
    if (ln.texts.empty()) return false;
    auto edgeOf = [&](const SText& t, int ci) {
        return static_cast<size_t>(ci) + 1 < t.g.size()
                   ? t.m.e + t.g[static_cast<size_t>(ci) + 1].x * t.m.a
                   : t.x1;
    };
    auto gapBoundaryAfter = [&](int k) {
        if (static_cast<size_t>(k) + 1 >= ln.texts.size()) return false;
        const SText& a = pool[static_cast<size_t>(ln.texts[static_cast<size_t>(k)])];
        const SText& b = pool[static_cast<size_t>(ln.texts[static_cast<size_t>(k) + 1])];
        return b.x0 - a.x1 >= 0.28f * a.size * a.m.a;
    };

    auto boundaryAt = [&](int k, int ci) {
        const SText& t = pool[static_cast<size_t>(ln.texts[static_cast<size_t>(k)])];
        if (isBoundary(t, static_cast<size_t>(ci))) return true;
        return static_cast<size_t>(ci) + 1 == t.g.size() && gapBoundaryAfter(k);
    };
    for (int k = static_cast<int>(ln.texts.size()) - 1; k >= 0; k--) {
        const SText& t = pool[static_cast<size_t>(ln.texts[static_cast<size_t>(k)])];
        if (t.g.empty()) continue;
        int ci = static_cast<int>(t.g.size());
        while (--ci >= 0 && edgeOf(t, ci) > limitX) {}
        if (ci < 0) continue;
        if (boundaryAt(k, ci)) { *out = {k, ci}; return true; }
        if (static_cast<size_t>(ci) + 1 < t.g.size() &&
            isBoundary(t, static_cast<size_t>(ci) + 1)) { *out = {k, ci}; return true; }
        while (ci > 0) {
            --ci;
            if (boundaryAt(k, ci)) { *out = {k, ci}; return true; }
        }
        for (int u = k; u >= 1; u--) {
            const SText& pv = pool[static_cast<size_t>(ln.texts[static_cast<size_t>(u) - 1])];
            for (int c = static_cast<int>(pv.text.size()) - 1; c >= 0; c--)
                if (boundaryAt(u - 1, c)) { *out = {u - 1, c}; return true; }
        }
        return false;
    }
    return false;
}

}

bool commitParagraphSurgical(Session& s, FPDF_PAGE page, Paragraph& p,
                             const std::vector<ParaRun>& newRuns,
                             const Paragraph& formatted) {
    if (!s.surgicalEnabled || getenv("EC_NO_SURGICAL")) EC_SBAIL("kill switch");

    if (!p.editable || p.vertical || p.rotation != 0) EC_SBAIL("editable/vertical/rotation");
    if (p.unwrapsForms || !p.flattenForms.empty()) EC_SBAIL("forms");

    std::set<FPDF_PAGEOBJECT> sharedObjs;
    if (p.sharesObjects) {
        auto itPage = s.pages.find(page);
        if (itPage == s.pages.end()) EC_SBAIL("shares: no page state");
        for (const Paragraph& q : itPage->second.paras) {
            if (q.id == p.id) continue;
            for (const OwnedObject& oo : q.objects)
                if (oo.object) sharedObjs.insert(oo.object);
            for (const ParaRun& r : q.runs)
                if (r.atomicObject) sharedObjs.insert(r.atomicObject);
        }
    }

    if (s.fontsFragile.count(page)) EC_SBAIL("fragile fonts");
    if (p.fmt.align == 3) EC_SBAIL("justify");

    const auto& f0 = p.fmt;
    const auto& f1 = formatted.fmt;
    if (f0.align != f1.align || f0.dir != f1.dir ||
        f0.list_level != f1.list_level ||
        !nearlyEq(f0.line_spacing, f1.line_spacing) ||
        !nearlyEq(f0.char_spacing, f1.char_spacing) ||
        !nearlyEq(f0.para_spacing, f1.para_spacing) ||
        !nearlyEq(f0.word_spacing, f1.word_spacing) ||
        !nearlyEq(f0.first_indent, f1.first_indent) ||
        !nearlyEq(f0.hang_indent, f1.hang_indent))
        EC_SBAIL("format changed");

    auto coalesce = [](const std::vector<ParaRun>& in) {
        std::vector<ParaRun> out;
        for (const ParaRun& r : in) {
            if (!out.empty() && !r.atomicObject && !out.back().atomicObject &&
                sameStyle(out.back().style, r.style)) {
                out.back().text += r.text;
            } else {
                out.push_back(r);
            }
        }
        return out;
    };
    const std::vector<ParaRun> oldRuns = coalesce(p.runs);
    const std::vector<ParaRun> newRuns2 = coalesce(newRuns);
    if (oldRuns.empty() || newRuns2.empty()) EC_SBAIL("run count");

    struct StyledText {
        std::u16string text;
        std::vector<const RunStyle*> style;
        std::vector<FPDF_PAGEOBJECT> atom;
    };
    auto buildStyled = [](const std::vector<ParaRun>& runs) {
        StyledText st;
        for (const ParaRun& r : runs) {
            if (r.atomicObject) {
                st.text.push_back(0xFFFC);
                st.style.push_back(&r.style);
                st.atom.push_back(r.atomicObject);
                continue;
            }
            for (char16_t c : r.text) {
                st.text.push_back(c);
                st.style.push_back(&r.style);
                st.atom.push_back(nullptr);
            }
        }
        return st;
    };
    const StyledText oldS = buildStyled(oldRuns);
    const StyledText newS = buildStyled(newRuns2);
    const std::u16string& oldT = oldS.text;
    const std::u16string& newT = newS.text;
    size_t pre = 0;
    while (pre < oldT.size() && pre < newT.size() && oldT[pre] == newT[pre] &&
           sameStyle(*oldS.style[pre], *newS.style[pre]) &&
           oldS.atom[pre] == newS.atom[pre])
        pre++;
    size_t sufO = oldT.size(), sufN = newT.size();
    while (sufO > pre && sufN > pre && oldT[sufO - 1] == newT[sufN - 1] &&
           sameStyle(*oldS.style[sufO - 1], *newS.style[sufN - 1]) &&
           oldS.atom[sufO - 1] == newS.atom[sufN - 1]) {
        sufO--;
        sufN--;
    }
    const std::u16string inserted = newT.substr(pre, sufN - pre);
    if (pre == sufO && inserted.empty()) EC_SBAIL("no text change");
    for (size_t k = pre; k < sufO; k++)
        if (oldS.atom[k]) EC_SBAIL("atomic text changed");

    for (size_t k = pre; k < sufN; k++) {
        if (newS.atom[k]) EC_SBAIL("atomic inserted");
        if (!sameStyle(*newS.style[k], *newS.style[pre])) EC_SBAIL("inserted style");
    }
    if (!inserted.empty()) {
        const RunStyle* at = pre < oldS.style.size()
                                 ? oldS.style[pre]
                                 : (pre > 0 ? oldS.style[pre - 1] : nullptr);
        if (!at || !sameStyle(*newS.style[pre], *at)) EC_SBAIL("style changed");
    }

    auto isRtlScript = [](char16_t c) {
        return (c >= 0x0590 && c <= 0x08FF) ||
               (c >= 0xFB1D && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);
    };

    bool rtlInsert = false;
    for (char16_t c : inserted)
        if (isRtlScript(c)) rtlInsert = true;
    if (rtlInsert) {
        const bool leftFree = pre == 0 || isWs(newT[pre - 1]) ||
                              (!inserted.empty() && isWs(inserted.front()));
        const bool rightFree = sufN >= newT.size() || isWs(newT[sufN]) ||
                               (!inserted.empty() && isWs(inserted.back()));
        if (!leftFree || !rightFree) EC_SBAIL("rtl insert mid-word");
        if (pre != sufO) EC_SBAIL("rtl replace");
    }
    for (char16_t c : inserted)
        if (c == u'\n' || c == u'\r' || isUndecodableChar(c) ||
            cpNeedsComplexShaping(c) || c == 0x2028 ||
            (!rtlInsert && isRtlScript(c)))
            EC_SBAIL("inserted char class");

    for (size_t k = pre; k < sufO; k++)
        if (oldT[k] == u'\n' ||
            (!inserted.empty() &&
             (cpNeedsComplexShaping(oldT[k]) || isRtlScript(oldT[k]))))
            EC_SBAIL("removed char class");

    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (!tp) EC_SBAIL("no text page");

    std::map<FPDF_PAGEOBJECT, std::u16string> realText;
    std::map<FPDF_PAGEOBJECT, std::vector<float>> realX;
    {
        const int nch = FPDFText_CountChars(tp);
        for (int i = 0; i < nch; i++) {
            FPDF_PAGEOBJECT o = FPDFText_GetTextObject(tp, i);
            if (!o) continue;
            const unsigned int uc = FPDFText_GetUnicode(tp, i);
            realText[o].push_back(uc == 0 || uc > 0xFFFF
                                      ? static_cast<char16_t>(0xFFFD)
                                      : static_cast<char16_t>(uc));
            double cxp = 0, cyp = 0;
            FPDFText_GetCharOrigin(tp, i, &cxp, &cyp);
            realX[o].push_back(static_cast<float>(cxp));
        }
    }
    FPDFText_ClosePage(tp);
    std::vector<SText> pool;
    bool ok = true;
    const char* why = "";
    for (const OwnedObject& oo : p.objects) {
        if (!oo.object) continue;
        if (oo.container) { why = "container"; ok = false; break; }
        const int type = FPDFPageObj_GetType(oo.object);
        if (type == FPDF_PAGEOBJ_PATH) { why = "path-deco"; ok = false; break; }
        if (type != FPDF_PAGEOBJ_TEXT) { why = "non-text"; ok = false; break; }
        SText t;
        t.obj = oo.object;
        t.preserved = oo.preserved;
        if (!FPDFPageObj_GetMatrix(oo.object, &t.m)) { why = "matrix"; ok = false; break; }

        if (t.m.b != 0 || t.m.c != 0 || t.m.a <= 0 || t.m.d <= 0) { why = "shear"; ok = false; break; }
        FPDFTextObj_GetFontSize(oo.object, &t.size);
        t.font = FPDFTextObj_GetFont(oo.object);
        t.g = readOrigGlyphs(oo.object);
        if (t.g.empty()) { why = "no glyphs"; ok = false; break; }
        for (const OrigGlyph& g : t.g)
            if (g.y != 0) { why = "glyph y"; ok = false; break; }
        if (!ok) break;
        t.shared = sharedObjs.count(oo.object) != 0;
        {
            auto rt = realText.find(oo.object);
            t.text = rt != realText.end() ? rt->second : std::u16string();
            auto rx = realX.find(oo.object);
            if (rx != realX.end()) t.tx = rx->second;
        }

        if (!t.preserved && t.tx.size() == t.text.size() && !t.g.empty()) {
            const std::vector<uint8_t>* fb = fontBytesFor(s, t.font);
            for (size_t k = 0; fb && k < t.text.size(); k++) {
                const char16_t u = t.text[k];
                if (u < 0x00A0 || u >= 0x0590) continue;
                int best = -1;
                float bd = 0;
                for (size_t j = 0; j < t.g.size(); j++) {
                    const float d = std::abs(t.m.e + t.g[j].x * t.m.a - t.tx[k]);
                    if (best < 0 || d < bd) { best = static_cast<int>(j); bd = d; }
                }
                if (best < 0) continue;
                const std::u16string nm = hbGlyphNameText(
                    fb->data(), fb->size(), t.g[static_cast<size_t>(best)].code);
                if (nm.size() == 1 && isRtlChar(nm[0])) t.text[k] = nm[0];
            }
        }
        unreverseGlyphClustersInPlace(t.text, t.tx);

        unshapeArabicInPlace(t.text);

        if (!t.preserved) {
            const size_t n2 = t.text.size();
            bool sane = n2 > 0 && t.tx.size() == n2 && !t.g.empty();
            std::vector<int> map2(n2, -1);
            bool trivial = sane && n2 == t.g.size();
            const float tol = std::max(0.5f, 0.05f * t.size);
            for (size_t k = 0; sane && k < n2; k++) {
                int best = -1;
                float bd = 0;
                for (size_t j = 0; j < t.g.size(); j++) {
                    const float gpx = t.m.e + t.g[j].x * t.m.a;
                    const float d = std::abs(gpx - t.tx[k]);
                    if (best < 0 || d < bd) { best = static_cast<int>(j); bd = d; }
                }
                if (best < 0 || bd > tol) { sane = false; break; }
                map2[k] = best;
                if (static_cast<size_t>(best) != k) trivial = false;
            }
            if (!sane) t.sealed = true;
            else if (!trivial) t.t2g = std::move(map2);

            if (sane && textIsRtl(t.text) && t.text.size() > 1) {

                bool sortable = true, descending = true;
                for (size_t k = 0; k < t.text.size(); k++) {
                    const char16_t c = t.text[k];
                    if (isRtlChar(c) || isWs(c)) continue;
                    if ((c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') ||
                        (c >= u'0' && c <= u'9') || c >= 0x00C0)
                        sortable = false;
                }
                for (size_t k = 0; k + 1 < t.tx.size(); k++)
                    if (t.tx[k + 1] > t.tx[k]) { descending = false; break; }
                if (sortable && !descending) {
                    std::vector<int> idx(t.text.size());
                    for (size_t k = 0; k < idx.size(); k++) idx[k] = static_cast<int>(k);
                    std::stable_sort(idx.begin(), idx.end(), [&](int a, int b) {
                        return t.tx[a] > t.tx[b];
                    });
                    std::u16string nt;
                    std::vector<float> ntx;
                    std::vector<int> ng;
                    nt.reserve(idx.size());
                    for (int k : idx) {
                        nt.push_back(t.text[static_cast<size_t>(k)]);
                        ntx.push_back(t.tx[static_cast<size_t>(k)]);
                        ng.push_back(t.t2g.empty() ? k : t.t2g[static_cast<size_t>(k)]);
                    }
                    t.text = std::move(nt);
                    t.tx = std::move(ntx);
                    bool triv2 = ng.size() == t.g.size();
                    for (size_t k = 0; triv2 && k < ng.size(); k++)
                        triv2 = ng[k] == static_cast<int>(k);
                    t.t2g = triv2 ? std::vector<int>() : std::move(ng);
                }
            }
        }
        float l = 0, b2 = 0, r2 = 0, t2 = 0;
        if (!FPDFPageObj_GetBounds(oo.object, &l, &b2, &r2, &t2)) { why = "bounds"; ok = false; break; }
        t.x0 = l;
        t.x1 = r2;
        pool.push_back(std::move(t));
    }
    if (!ok || pool.empty()) {
        if (getenv("EC_SURGICAL_DEBUG"))
            fprintf(stderr, "[surgical] collect sub-reason: %s\n", why);
        EC_SBAIL("object collection");
    }

    std::vector<SLine> lines;
    {
        std::vector<int> order(pool.size());
        for (size_t i = 0; i < order.size(); i++) order[i] = static_cast<int>(i);
        std::sort(order.begin(), order.end(), [&](int a, int b) {
            const float dy = pool[static_cast<size_t>(a)].m.f - pool[static_cast<size_t>(b)].m.f;
            if (std::abs(dy) > 2.0f) return dy > 0;
            return pool[static_cast<size_t>(a)].m.e < pool[static_cast<size_t>(b)].m.e;
        });
        for (int oi : order) {
            SText& t = pool[static_cast<size_t>(oi)];
            if (lines.empty() || std::abs(lines.back().baseline - t.m.f) > 2.0f) {
                lines.push_back(SLine{});
                lines.back().baseline = t.m.f;
                lines.back().penX = t.m.e;
            }
            t.line = static_cast<int>(lines.size()) - 1;
            lines.back().texts.push_back(oi);
        }
    }
    if (lines.size() != p.lines.size()) EC_SBAIL("line grouping mismatch");

    const std::u16string removed = oldT.substr(pre, sufO - pre);
    auto flexFind = [](const std::u16string& hay, const std::u16string& needle,
                       std::vector<std::pair<size_t, size_t>>* hits) {
        for (size_t at = 0; at < hay.size() || (needle.empty() && at == 0); at++) {
            size_t h = at, n = 0;
            while (n < needle.size()) {
                if (needle[n] == u' ') {
                    n++;
                    if (h < hay.size() && hay[h] == u' ') h++;
                    continue;
                }
                if (h >= hay.size() || hay[h] != needle[n]) break;
                h++; n++;
            }
            if (n == needle.size()) hits->push_back({at, h});
            if (at >= hay.size()) break;
        }
    };

    const size_t CTX = 4;
    size_t cl = 0;
    while (cl < CTX && pre - cl > 0) {
        const char16_t c = oldT[pre - cl - 1];
        if (c == u'\n' || c == u'\r' || c == 0xFFFC) break;
        cl++;
    }
    size_t cr = 0;
    while (cr < CTX && sufO + cr < oldT.size()) {
        const char16_t c = oldT[sufO + cr];
        if (c == u'\n' || c == u'\r' || c == 0xFFFC) break;
        cr++;
    }
    const std::u16string ctxFullL = oldT.substr(pre - cl, cl);
    const std::u16string ctxFullR = oldT.substr(sufO, cr);
    if (ctxFullL.empty() && ctxFullR.empty() && removed.empty())
        EC_SBAIL("empty needle");
    int ti = -1;
    size_t spliceLo = 0;
    int spliceLine = -1;
    size_t spliceCatLo = 0, spliceCatHi = 0;
    bool spliceRev = false;
    std::vector<std::pair<int, size_t>> spliceAt;

    for (int attempt = 0; attempt < 2 && ti < 0; attempt++) {
    const std::u16string& ctxL = attempt == 0 ? ctxFullL : std::u16string();
    const std::u16string& ctxR = attempt == 0 ? ctxFullR : std::u16string();
    if (attempt == 1 &&
        (removed.empty() || (ctxFullL.empty() && ctxFullR.empty())))
        break;
    const std::u16string needle = ctxL + removed + ctxR;
    if (needle.empty()) break;
    for (size_t li = 0; li < lines.size(); li++) {

      for (int ord = 0; ord < 2; ord++) {
        std::u16string cat;
        std::vector<std::pair<int, size_t>> at;
        const std::vector<int>& seq = lines[li].texts;
        for (size_t si2 = 0; si2 < seq.size(); si2++) {
            const int idx = ord == 0 ? seq[si2] : seq[seq.size() - 1 - si2];
            const SText& t = pool[static_cast<size_t>(idx)];
            if (t.preserved || t.sealed) { cat.push_back(0xFFFC); at.push_back({-1, 0}); continue; }
            for (size_t c = 0; c < t.text.size(); c++) {
                cat.push_back(t.text[c]);
                at.push_back({idx, c});
            }
        }
        std::vector<std::pair<size_t, size_t>> hits;
        flexFind(cat, needle, &hits);
        for (const auto& hit : hits) {
            size_t h = hit.first;
            auto walk = [&](const std::u16string& part) {
                for (char16_t c : part) {
                    if (c == u' ') {
                        if (h < cat.size() && cat[h] == u' ') h++;
                        continue;
                    }
                    h++;
                }
            };
            walk(ctxL);
            const size_t lo = h;
            walk(removed);
            const size_t hi = h;
            bool backed = true;
            for (size_t k2 = lo; k2 < hi; k2++)
                if (k2 >= at.size() || at[k2].first < 0) { backed = false; break; }
            if (!backed) continue;
            int anchorObj = -1;
            size_t anchorChr = 0;
            if (hi > lo) {
                anchorObj = at[lo].first;
                anchorChr = at[lo].second;
            } else if (lo > 0 && lo - 1 < at.size() && at[lo - 1].first >= 0) {
                anchorObj = at[lo - 1].first;
                anchorChr = at[lo - 1].second + 1;
            } else if (lo < at.size() && at[lo].first >= 0) {
                anchorObj = at[lo].first;
                anchorChr = at[lo].second;
            } else {
                continue;
            }

            if (ti >= 0 &&
                (ti != anchorObj || spliceLo != anchorChr))
                EC_SBAIL("splice site ambiguous");
            if (ti >= 0) continue;
            ti = anchorObj;
            spliceLo = anchorChr;
            spliceLine = static_cast<int>(li);
            spliceCatLo = lo;
            spliceCatHi = hi;
            spliceRev = ord == 1;
            spliceAt = at;
        }

        if (seq.size() < 2) break;
      }
    }
    }
    if (ti < 0) EC_SBAIL("touched object not found");
    SText& tt = pool[static_cast<size_t>(ti)];
    if (tt.m.a != tt.m.d) EC_SBAIL("anisotropic matrix");
    if (tt.preserved || tt.sealed) EC_SBAIL("anchor sealed");
    if (spliceLine < 0) EC_SBAIL("splice line unknown");
    tt.line = spliceLine;

    struct Cut { int obj; size_t lo, hi; };
    std::vector<Cut> cuts;
    for (size_t k = spliceCatLo; k < spliceCatHi; k++) {
        const int o = spliceAt[k].first;
        const size_t c = spliceAt[k].second;
        if (!cuts.empty() && cuts.back().obj == o) cuts.back().hi = c + 1;
        else cuts.push_back({o, c, c + 1});
    }
    if (cuts.empty()) cuts.push_back({ti, spliceLo, spliceLo});
    if (cuts.front().obj != ti) EC_SBAIL("span anchor mismatch");
    for (const Cut& c : cuts) {
        const SText& t = pool[static_cast<size_t>(c.obj)];
        if (t.preserved || t.sealed) EC_SBAIL("span crosses sealed object");
        if (t.m.b != 0 || t.m.c != 0 || t.m.a != t.m.d || t.m.a <= 0)
            EC_SBAIL("span object matrix");
    }
    for (size_t k = 1; k < cuts.size(); k++) {
        const SText& t = pool[static_cast<size_t>(cuts[k].obj)];
        const bool last = k + 1 == cuts.size();
        if (cuts[k].lo != 0) EC_SBAIL("span gap");
        if (!last && cuts[k].hi != t.g.size()) EC_SBAIL("span hole");
    }

    auto xDir = [](const float* v, size_t n, int& dir) {
        dir = 0;
        bool asc = true, desc = true;
        for (size_t k = 0; k + 1 < n; k++) {
            if (v[k + 1] < v[k]) asc = false;
            if (v[k + 1] > v[k]) desc = false;
        }
        if (!asc && !desc) return false;
        dir = (asc && desc) ? 0 : (asc ? 1 : -1);
        return true;
    };

    auto t2gReversed = [](const SText& t) {
        for (size_t k = 1; k < t.t2g.size(); k++)
            if (t.t2g[k] < t.t2g[k - 1]) return true;
        return false;
    };

    auto mapCut = [](const SText& t, size_t aLo, size_t aHi, size_t& gLo,
                     size_t& gHi) {
        const size_t gN = t.g.size();
        if (t.t2g.empty()) {
            gLo = std::min(aLo, gN);
            gHi = std::min(aHi, gN);
            return true;
        }
        if (aHi > t.t2g.size()) return false;
        if (aLo >= aHi) {
            const size_t at = aLo < t.t2g.size()
                                  ? static_cast<size_t>(t.t2g[aLo])
                                  : gN;
            gLo = gHi = std::min(at, gN);
            return true;
        }
        size_t lo = gN, hi = 0;
        for (size_t k = aLo; k < aHi; k++) {
            const size_t j = static_cast<size_t>(t.t2g[k]);
            lo = std::min(lo, j);
            hi = std::max(hi, j + 1);
        }
        if (hi <= lo) return false;

        std::vector<char> hit(hi - lo, 0);
        for (size_t k = 0; k < t.t2g.size(); k++) {
            const size_t j = static_cast<size_t>(t.t2g[k]);
            if (j < lo || j >= hi) continue;
            if (k < aLo || k >= aHi) return false;
            hit[j - lo] = 1;
        }
        for (char h : hit)
            if (!h) return false;
        gLo = lo;
        gHi = hi;
        return true;
    };
    auto orientation = [&](const SText& t, bool& revOut) {
        revOut = false;
        std::vector<float> gx;
        gx.reserve(t.g.size());
        for (const OrigGlyph& g2 : t.g) gx.push_back(g2.x);
        int gd = 0;
        if (!xDir(gx.data(), gx.size(), gd)) return false;
        revOut = t.g.size() >= 2 && gd < 0;
        return true;
    };
    bool rev = false;
    if (!orientation(tt, rev)) EC_SBAIL("anchor glyphs not monotonic");
    const bool revIdx = t2gReversed(tt);
    for (size_t k = 1; k < cuts.size(); k++) {
        bool r2 = false;
        if (!orientation(pool[static_cast<size_t>(cuts[k].obj)], r2) || r2)
            EC_SBAIL("span object orientation");

        if (t2gReversed(pool[static_cast<size_t>(cuts[k].obj)]))
            EC_SBAIL("span object order");
    }

    if (rev || revIdx || spliceRev) {
        if (!inserted.empty() && !rtlInsert) EC_SBAIL("rtl insertion");
        if (cuts.size() > 1) EC_SBAIL("rtl cross-object span");
    }
    if (rtlInsert && cuts.size() > 1) EC_SBAIL("rtl insert cross-object");

    if (cuts.size() == 1) {
        for (int idx : lines[static_cast<size_t>(spliceLine)].texts) {
            if (idx == ti) continue;
            const SText& lt = pool[static_cast<size_t>(idx)];
            if (lt.g.size() < 2) continue;
            bool r3 = false;
            if (!orientation(lt, r3) || r3 != rev)
                EC_SBAIL("mixed-direction line");
        }

        spliceRev = rev || revIdx;
    } else if (rev != spliceRev &&
               lines[static_cast<size_t>(spliceLine)].texts.size() > 1) {
        EC_SBAIL("mixed-direction line");
    }

    if (!sharedObjs.empty()) {
        if (!inserted.empty()) EC_SBAIL("shares: insertion");
        if (tt.shared) EC_SBAIL("shares: anchor");
        for (const Cut& c : cuts)
            if (pool[static_cast<size_t>(c.obj)].shared) EC_SBAIL("shares: span");
        const SLine& lnG = lines[static_cast<size_t>(spliceLine)];
        bool afterG = false;
        for (size_t k = 0; k < lnG.texts.size(); k++) {
            const int idx = spliceRev ? lnG.texts[lnG.texts.size() - 1 - k]
                                      : lnG.texts[k];
            if (idx == ti) { afterG = true; continue; }
            if (afterG && pool[static_cast<size_t>(idx)].shared)
                EC_SBAIL("shares: line tail");
        }
    }

    std::map<char16_t, uint32_t> localEnc;
    for (const SText& t : pool) {
        if (t.preserved || t.sealed || t.font != tt.font) continue;

        std::vector<int> refs(t.g.size(), 0);
        for (size_t k = 0; k < t.text.size(); k++) {
            const size_t j = t.t2g.empty() ? k : static_cast<size_t>(t.t2g[k]);
            if (j < refs.size()) refs[j]++;
        }
        for (size_t k = 0; k < t.text.size(); k++) {
            const size_t j = t.t2g.empty() ? k : static_cast<size_t>(t.t2g[k]);
            if (j < t.g.size() && refs[j] == 1)
                localEnc.emplace(t.text[k], t.g[j].code);
        }
    }
    auto encIt = s.fontUniToCode.find(tt.font);

    std::u16string insEmit = inserted;
    if (rtlInsert) {
        const std::vector<uint8_t>* fb = fontBytesFor(s, tt.font);
        if (!fb) EC_SBAIL("rtl insert: no font bytes");
        int proofs = 0;
        for (size_t k = 0; k < tt.text.size(); k++) {
            const size_t j = tt.t2g.empty() ? k : static_cast<size_t>(tt.t2g[k]);
            if (j >= tt.g.size()) continue;
            const char16_t base = tt.text[k];
            if (!isRtlScript(base)) continue;
            std::u16string one(1, base);
            bool joins = false;
            for (int form = 0; form < 4 && proofs >= 0; form++) {
                std::u16string probe = one;
                joins = form & 1;
                shapeArabicInPlace(probe, &joins, nullptr);
                if (probe.size() == 1 &&
                    hbGlyphIdForText(fb->data(), fb->size(), probe) ==
                        tt.g[j].code) {
                    proofs++;
                    break;
                }
            }
        }
        if (proofs < 1) EC_SBAIL("rtl insert: charcodes are not glyph ids");
        bool joins = false;
        shapeArabicInPlace(insEmit, &joins, nullptr);
    }
    std::vector<uint32_t> insCodes;
    for (char16_t c : insEmit) {
        uint32_t code = 0;
        bool found = false;
        auto l = localEnc.find(c);
        if (l != localEnc.end()) { code = l->second; found = true; }
        if (!found && encIt != s.fontUniToCode.end()) {
            auto e = encIt->second.find(c);
            if (e != encIt->second.end()) { code = e->second; found = true; }
        }
        if (!found && rtlInsert) {
            const std::vector<uint8_t>* fb = fontBytesFor(s, tt.font);
            const uint32_t g2 = fb ? hbGlyphIdForText(fb->data(), fb->size(),
                                                      std::u16string(1, c))
                                   : 0;
            if (g2) { code = g2; found = true; }
        }
        if (!found) EC_SBAIL("charcode unmapped");
        insCodes.push_back(code);
    }

    std::vector<float> insAdv(insCodes.size(), -1.0f);
    for (size_t k = 0; k < insCodes.size(); k++) {
        const float d = docAdv(pool, tt.font, tt.size, insCodes[k], insEmit[k]);
        if (d < 0 && rtlInsert) {
            const float c2 = cidAdv(s, tt.font, tt.size, insCodes[k]);
            if (c2 > 0) { insAdv[k] = c2; continue; }
        }
        if (d < 0) EC_SBAIL("no advance");
        insAdv[k] = d;
    }
    float insW = 0;
    for (float d : insAdv) insW += d;
    const float insPageW = insW * tt.m.a;

    const size_t aLo = cuts.front().lo;
    const size_t aHi = cuts.front().hi;
    const size_t gN = tt.g.size();
    size_t gLo = 0, gHi = 0;
    if (!mapCut(tt, aLo, aHi, gLo, gHi)) EC_SBAIL("cut spans reordered text");

    size_t rtlAnchorGlyph = 0;
    if (rtlInsert) {
        if (aLo == 0) EC_SBAIL("rtl insert at object start");
        rtlAnchorGlyph = tt.t2g.empty() ? aLo - 1
                                        : static_cast<size_t>(tt.t2g[aLo - 1]);
        if (rtlAnchorGlyph >= gN) EC_SBAIL("rtl insert anchor glyph");
        gLo = gHi = rev ? rtlAnchorGlyph + 1 : rtlAnchorGlyph;
    }
    const float pageStart = gLo < gN ? tt.m.e + tt.g[gLo].x * tt.m.a
                                     : tt.x1;

    float pageEnd = pageStart;
    if (spliceCatHi > spliceCatLo) {
        if (!rev) {
            const Cut& lastCut = cuts.back();
            const SText& tb = pool[static_cast<size_t>(lastCut.obj)];

            const size_t gLast = cuts.size() == 1 ? gHi - 1 : lastCut.hi - 1;
            const OrigGlyph& gl = tb.g[gLast];
            size_t tLast = lastCut.hi - 1;
            if (!tb.t2g.empty()) {
                for (size_t k = 0; k < tb.t2g.size(); k++)
                    if (static_cast<size_t>(tb.t2g[k]) == gLast) { tLast = k; break; }
            }
            const float adv = docAdv(pool, tb.font, tb.size, gl.code,
                                     tLast < tb.text.size() ? tb.text[tLast]
                                                            : u' ');
            if (adv < 0) EC_SBAIL("no advance for removed tail");
            pageEnd = tb.m.e + (gl.x + adv) * tb.m.a;
        } else {

            const OrigGlyph& gl = tt.g[gHi - 1];
            const float adv = cidAdv(s, tt.font, tt.size, gl.code);
            if (adv <= 0) EC_SBAIL("no advance for removed tail");
            const float spanW = (tt.g[gLo].x - gl.x) + adv;
            pageEnd = pageStart + spanW * tt.m.a;
        }
    }
    const float dPage = insPageW - (pageEnd - pageStart);

    std::set<int> spanObjs;
    for (const Cut& c : cuts) spanObjs.insert(c.obj);
    const bool singleObj = cuts.size() == 1;
    {

        const bool rtlPin = revIdx && !rev;
        const float dText = (rev ? -dPage : dPage) / tt.m.a;
        std::vector<OrigGlyph> next;
        next.reserve(gN);
        for (size_t k = 0; k < std::min(gLo, gN); k++) {
            OrigGlyph g = tt.g[k];
            if (rtlPin && singleObj) g.x -= dText;
            next.push_back(g);
        }
        const float penText = gLo < gN ? tt.g[gLo].x
                                       : (tt.x1 - tt.m.e) / tt.m.a;
        if (rtlInsert) {

            float xr = tt.g[rtlAnchorGlyph].x;
            std::vector<OrigGlyph> add;
            add.reserve(insCodes.size());
            for (size_t k = 0; k < insCodes.size(); k++) {
                xr -= insAdv[k];
                add.push_back({insCodes[k], xr, 0});
            }
            if (!rev) std::reverse(add.begin(), add.end());
            next.insert(next.end(), add.begin(), add.end());
        } else {
            float x = penText;
            for (size_t k = 0; k < insCodes.size(); k++) {
                next.push_back({insCodes[k], x, 0});
                x += insAdv[k];
            }
        }
        if (singleObj) {
            for (size_t k = gHi; k < gN; k++) {
                OrigGlyph g = tt.g[k];
                if (!rtlPin) g.x += dText;
                next.push_back(g);
            }
        }
        if (next.empty()) {

            historyRemoveObject(s, page, nullptr, tt.obj);
            tt.obj = nullptr;
            tt.text.clear();
            tt.g.clear();
        } else {
            if (!applyCodes(s, tt, next)) EC_SBAIL("SetCharcodes failed");
            std::u16string nt = tt.text.substr(0, aLo) + inserted;
            if (singleObj) nt += tt.text.substr(std::min(aHi, tt.text.size()));
            tt.text = nt;

            if (rtlPin) {
                tt.x0 -= dPage;
                if (gHi >= gN) tt.x1 += dPage;
            } else if (!rev) {
                tt.x1 = singleObj ? tt.x1 + dPage : pageStart + insPageW;
            } else if (gLo == 0) {
                tt.x1 += dPage;
            }
        }
    }
    if (!singleObj) {
        for (size_t k = 1; k < cuts.size(); k++) {
            SText& t = pool[static_cast<size_t>(cuts[k].obj)];
            const bool last = k + 1 == cuts.size();
            if (!last || cuts[k].hi >= t.g.size()) {

                historyRemoveObject(s, page, nullptr, t.obj);
                t.obj = nullptr;
            } else {

                std::vector<OrigGlyph> keep(t.g.begin() + static_cast<long>(cuts[k].hi),
                                            t.g.end());
                if (!applyCodes(s, t, keep)) EC_SBAIL("tail trim failed");
                t.text = t.text.substr(cuts[k].hi);
                translatePage(s, t, dPage, 0);
            }
        }
    }

    {
        SLine& ln = lines[static_cast<size_t>(spliceLine)];
        const std::vector<int>& seq = ln.texts;
        bool after = false;
        for (size_t k = 0; k < seq.size(); k++) {
            const int idx = spliceRev ? seq[seq.size() - 1 - k] : seq[k];
            if (idx == ti) { after = true; continue; }
            if (!after || spanObjs.count(idx)) continue;
            translatePage(s, pool[static_cast<size_t>(idx)], spliceRev ? -dPage : dPage, 0);
        }

        ln.texts.erase(std::remove_if(ln.texts.begin(), ln.texts.end(), [&](int idx) {
            return pool[static_cast<size_t>(idx)].obj == nullptr;
        }), ln.texts.end());
    }

    const float boxL = p.x;
    const float boxR = p.x + p.width;
    auto lineRight = [&](const SLine& L) {
        float r2 = -1e9f;
        for (int idx : L.texts) r2 = std::max(r2, pool[static_cast<size_t>(idx)].x1);
        return r2;
    };
    auto lineLeft = [&](const SLine& L) {
        float l2 = 1e9f;
        for (int idx : L.texts) l2 = std::min(l2, pool[static_cast<size_t>(idx)].x0);
        return l2;
    };
    float widenedTo = -1;
    if (lines.size() == 1) {

        const float r2 = lineRight(lines[0]);
        if (r2 > boxR) widenedTo = r2 - boxL;
    } else if (p.fmt.align == 0) {

        for (size_t li = static_cast<size_t>(spliceLine); li < lines.size(); li++) {
            int guard = 0;
            while (lineRight(lines[li]) > boxR + 0.6f && guard++ < 64) {
                WordCut cut;
                if (!movableFromEnd(pool, lines[li], boxR, &cut))
                    EC_SBAIL("unbreakable overflow");
                SLine& L = lines[li];
                const int poolIdx = L.texts[static_cast<size_t>(cut.t)];
                SText& host = pool[static_cast<size_t>(poolIdx)];
                std::vector<int> moved;
                if (static_cast<size_t>(cut.c) + 1 < host.g.size()) {

                    if (host.text.size() != host.g.size())
                        EC_SBAIL("cluster split");
                    const int tail = splitText(s, page, pool, poolIdx,
                                               static_cast<size_t>(cut.c) + 1);
                    if (tail < 0) EC_SBAIL("split failed");
                    moved.push_back(tail);
                }
                for (size_t k2 = static_cast<size_t>(cut.t) + 1; k2 < L.texts.size(); k2++)
                    moved.push_back(L.texts[k2]);
                if (moved.empty()) EC_SBAIL("nothing to migrate");
                L.texts.resize(static_cast<size_t>(cut.t) + 1);
                const bool newLine = li + 1 >= lines.size();
                if (newLine) {

                    const float pitch =
                        lines.size() >= 2
                            ? lines[lines.size() - 2].baseline - lines.back().baseline
                            : p.fmt.line_spacing * pool[static_cast<size_t>(moved[0])].size *
                                  pool[static_cast<size_t>(moved[0])].m.a;
                    SLine fresh;
                    fresh.baseline = lines.back().baseline - pitch;
                    fresh.penX = lines.back().penX;
                    lines.push_back(fresh);
                }
                SLine& dst = lines[li + 1];
                SText& first = pool[static_cast<size_t>(moved[0])];
                const float dx = dst.penX - first.m.e;
                const float dy = dst.baseline - first.m.f;
                float movedW = 0;
                {
                    float mn = 1e9f, mx = -1e9f;
                    for (int mi2 : moved) {
                        mn = std::min(mn, pool[static_cast<size_t>(mi2)].x0);
                        mx = std::max(mx, pool[static_cast<size_t>(mi2)].x1);
                    }
                    movedW = mx - mn;
                }
                for (int mi2 : moved) {
                    translatePage(s, pool[static_cast<size_t>(mi2)], dx, dy);
                    pool[static_cast<size_t>(mi2)].line = static_cast<int>(li) + 1;
                }

                if (!newLine && !dst.texts.empty()) {
                    const SText& lead = pool[static_cast<size_t>(dst.texts[0])];
                    float gap = nomAdv(lead.font, u' ', lead.size);
                    if (gap <= 0) gap = 0.3f * lead.size;
                    gap *= lead.m.a;
                    for (int idx : dst.texts)
                        translatePage(s, pool[static_cast<size_t>(idx)], movedW + gap, 0);
                }
                dst.texts.insert(dst.texts.begin(), moved.begin(), moved.end());
            }
            if (guard >= 64) EC_SBAIL("migration runaway");
        }
    } else {

        if (lineRight(lines[static_cast<size_t>(spliceLine)]) > boxR + 0.6f)
            EC_SBAIL("centered overflow");
    }

    if (p.fmt.align == 1 || p.fmt.align == 2) {
        SLine& L = lines[static_cast<size_t>(spliceLine)];
        const float w = lineRight(L) - lineLeft(L);
        const float want = p.fmt.align == 1
                               ? boxL + ((widenedTo < 0 ? p.width : widenedTo) - w) / 2
                               : boxR - w;
        const float dx = want - lineLeft(L);
        if (std::abs(dx) > 0.01f)
            for (int idx : L.texts) translatePage(s, pool[static_cast<size_t>(idx)], dx, 0);
    }

    if (widenedTo > 0) p.width = widenedTo;
    return true;
}

}


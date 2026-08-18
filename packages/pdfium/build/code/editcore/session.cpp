#include <cstdlib>

#include <ctime>

#include "ec_internal.h"
#include "fpdf_save.h"
#include "pdfium_internal.h"
#include "fpdf_signature.h"
#include "fpdf_structtree.h"
#include "fpdf_transformpage.h"

using namespace ec;

namespace {

Session* asSession(EC_SESSION s) { return static_cast<Session*>(s); }

char* dupString(const std::string& s) {
    char* out = static_cast<char*>(malloc(s.size() + 1));
    if (!out) return nullptr;
    memcpy(out, s.c_str(), s.size() + 1);
    return out;
}

bool textProvablyCovered(const std::u16string& text, const std::u16string& rendered) {
    return !text.empty() && rendered.find(text) != std::u16string::npos;
}

std::vector<float> sliceSrcAdvAt(const ParaRun& src, size_t at, size_t len) {
    if (!len || src.srcAdv.size() != src.text.size() ||
        at + len > src.srcAdv.size())
        return {};
    std::vector<float> out(src.srcAdv.begin() + static_cast<long>(at),
                           src.srcAdv.begin() + static_cast<long>(at + len));
    if (at + len < src.text.size()) out.back() = -1.0f;
    return out;
}

std::vector<float> sliceSrcAdv(const ParaRun& src, const std::u16string& piece) {
    if (piece.empty()) return {};
    const size_t at = src.text.find(piece);
    if (at == std::u16string::npos) return {};
    return sliceSrcAdvAt(src, at, piece.size());
}

void appendEditedRun(std::vector<ParaRun>& out, ParaRun r, const ParaRun& srcRun) {
    const std::u16string& oldText = srcRun.text;
    const std::u16string nt = r.text;
    const size_t n = nt.size(), o = oldText.size();
    size_t pre = 0;
    while (pre < n && pre < o && nt[pre] == oldText[pre]) ++pre;
    while (pre > 0 && nt[pre - 1] >= 0xD800 && nt[pre - 1] <= 0xDBFF) --pre;
    size_t suf = 0;
    while (suf < n - pre && suf < o - pre && nt[n - 1 - suf] == oldText[o - 1 - suf]) ++suf;
    while (suf > 0 && nt[n - suf] >= 0xDC00 && nt[n - suf] <= 0xDFFF) --suf;

    if (pre < n && pre > 0 && nt[pre] != u' ' && nt[pre - 1] != u' ') {
        size_t sp = nt.rfind(u' ', pre - 1);
        pre = (sp == std::u16string::npos) ? 0 : sp + 1;
    }

    if (suf > 0 && suf < n && nt[n - suf] != u' ' && nt[n - suf - 1] != u' ') {
        size_t sp = nt.find(u' ', n - suf);
        suf = (sp == std::u16string::npos) ? 0 : n - sp - 1;
    }
    if (pre + suf > n) suf = n - pre;
    if (pre == 0 && suf == 0) { out.push_back(std::move(r)); return; }
    auto emit = [&](std::u16string t, std::vector<float> adv, bool unchanged) {
        if (t.empty()) return;
        ParaRun piece = r;
        piece.text = std::move(t);
        piece.textUnchanged = unchanged;

        piece.srcAdv = std::move(adv);
        out.push_back(std::move(piece));
    };
    emit(nt.substr(0, pre), sliceSrcAdvAt(srcRun, 0, pre), true);
    emit(nt.substr(pre, n - pre - suf), {}, false);
    emit(nt.substr(n - suf), sliceSrcAdvAt(srcRun, o - suf, suf), true);
}

int scriptClassOf(uint32_t cp) {
    if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
        (cp >= 0x08A0 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFEFC))
        return 1;
    if ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F))
        return 2;
    if (cpNeedsComplexShaping(cp)) return 3;
    if ((cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0x3040 && cp <= 0x30FF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xAC00 && cp <= 0xD7FF) ||
        (cp >= 0xFF66 && cp <= 0xFF9F))
        return 4;
    if (cp == u' ' || cp == 0x00A0 || cp == u'\n' || cp == u'\r' ||
        cp == u'\t' || (cp >= 0x2000 && cp <= 0x200F))
        return -1;

    return 0;
}

void appendScriptRuns(std::vector<ParaRun>& out, ParaRun r) {
    const std::u16string& t = r.text;
    std::vector<int> cls(t.size(), -1);
    for (size_t i = 0; i < t.size(); i++) {
        uint32_t cp = t[i];
        const size_t i0 = i;
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < t.size() &&
            t[i + 1] >= 0xDC00 && t[i + 1] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (t[i + 1] - 0xDC00);
            i++;
        }
        const int c = scriptClassOf(cp);
        cls[i0] = c;
        if (i != i0) cls[i] = c;
    }

    int prev = -1;
    for (size_t i = 0; i < cls.size(); i++) {
        if (cls[i] >= 0) prev = cls[i];
        else if (prev >= 0) cls[i] = prev;
    }
    int next = -1;
    for (size_t i = cls.size(); i-- > 0;) {
        if (cls[i] >= 0) next = cls[i];
        else cls[i] = next < 0 ? 0 : next;
    }
    bool mixed = false;
    for (size_t i = 1; i < cls.size(); i++) mixed |= cls[i] != cls[0];
    if (!mixed) {
        out.push_back(std::move(r));
        return;
    }
    size_t start = 0;
    for (size_t i = 1; i <= cls.size(); i++) {
        if (i < cls.size() && cls[i] == cls[start]) continue;
        ParaRun piece = r;
        piece.text = t.substr(start, i - start);
        piece.srcAdv.clear();
        out.push_back(std::move(piece));
        start = i;
    }
}

std::vector<ParaRun> runsFromInput(const ec_run_in* runs, int count,
                                   const std::vector<ParaRun>* source = nullptr) {
    std::vector<ParaRun> out;

    std::vector<char> atomicUsed(source ? source->size() : 0, 0);
    for (int i = 0; i < count; i++) {
        const ec_run_in& in = runs[i];
        ParaRun r;
        r.text = utf8ToUtf16(in.utf8 ? in.utf8 : "");
        r.style.family = in.family ? in.family : "";

        r.style.bold = in.bold == 1;
        r.style.fauxBold = in.bold == 2;
        r.style.italic = in.italic == 1;
        r.style.fauxItalic = in.italic == 2;
        r.style.size = in.size > 0.5f ? in.size : 12.0f;
        r.style.rgba = in.rgba;
        r.style.underline = in.underline != 0;
        r.style.strike = in.strike != 0;
        r.style.script = in.script;
        r.style.renderMode = (in.render_mode > 0 && in.render_mode <= 7) ? in.render_mode : 0;
        r.style.strokeRgba = in.stroke_rgba != 0 ? in.stroke_rgba : in.rgba;
        r.style.strokeWidth = in.stroke_width > 0 ? in.stroke_width : 1.0f;
        r.style.hScale =
            (in.h_scale > 0.01f && in.h_scale < 100.0f) ? in.h_scale : 1.0f;
        r.style.rise = (in.rise > -300.0f && in.rise < 300.0f) ? in.rise : 0.0f;

        if (r.text.find(u'\uFFFC') != std::u16string::npos) {
            auto consume = [&]() -> const ParaRun* {
                if (!source) return nullptr;
                const int hint = in.source_run_index;
                if (hint >= 0 && hint < static_cast<int>(source->size()) &&
                    (*source)[hint].atomicObject && !atomicUsed[hint]) {
                    atomicUsed[hint] = 1;
                    return &(*source)[hint];
                }
                for (size_t k = 0; k < source->size(); k++) {
                    if ((*source)[k].atomicObject && !atomicUsed[k]) {
                        atomicUsed[k] = 1;
                        return &(*source)[k];
                    }
                }
                return nullptr;
            };
            std::u16string seg;
            auto flushSeg = [&]() {
                if (seg.empty()) return;
                ParaRun t = r;
                t.text = std::move(seg);
                seg.clear();
                appendScriptRuns(out, std::move(t));
            };
            for (char16_t ch : r.text) {
                if (ch != u'\uFFFC') {
                    seg.push_back(ch);
                    continue;
                }
                flushSeg();
                if (const ParaRun* a = consume()) {
                    ParaRun at = *a;

                    at.text = u"￼";
                    at.srcAdv.clear();
                    out.push_back(std::move(at));
                }
            }
            flushSeg();
            continue;
        }
        const ParaRun* src = nullptr;
        if (source && in.source_run_index >= 0 &&
            in.source_run_index < static_cast<int>(source->size())) {
            const ParaRun& cand = (*source)[in.source_run_index];
            if (cand.atomicObject) {

            } else if (cand.originalFont && cand.style.bold == r.style.bold &&
                cand.style.italic == r.style.italic &&
                cand.style.script == r.style.script) {
                src = &cand;
                r.originalFont = cand.originalFont;
                r.textUnchanged = (cand.text == r.text) ||
                                  textProvablyCovered(r.text, cand.text);

                if (r.textUnchanged) {
                    r.srcAdv = sliceSrcAdv(cand, r.text);
                    const float hs0 =
                        cand.style.hScale > 0.01f ? cand.style.hScale : 1.0f;
                    const float hs1 =
                        r.style.hScale > 0.01f ? r.style.hScale : 1.0f;
                    const float k =
                        (r.style.size / std::max(0.5f, cand.style.size)) *
                        (hs1 / hs0);
                    if (std::abs(k - 1.0f) > 0.001f)
                        for (float& a : r.srcAdv)
                            if (a > 0) a *= k;
                }
            } else if (cand.originalFont) {

                r.scriptFallbackFont = cand.originalFont;
            }
        }
        if (r.text.empty()) continue;
        if (src && !r.textUnchanged) appendEditedRun(out, std::move(r), *src);
        else if (!src && !r.originalFont) appendScriptRuns(out, std::move(r));
        else out.push_back(std::move(r));
    }
    return out;
}

void applyFormat(Paragraph& p, const ec_para_format* fmt) {
    if (!fmt) return;
    p.fmt.align = std::max(0, std::min(3, fmt->align));
    if (fmt->line_spacing > 0.3f && fmt->line_spacing < 6.0f) {
        p.fmt.line_spacing = fmt->line_spacing;
    }
    if (fmt->char_spacing > -5.0f && fmt->char_spacing < 50.0f) {
        p.fmt.char_spacing = fmt->char_spacing;
    }
    if (fmt->para_spacing >= 0.0f && fmt->para_spacing < 500.0f) {
        p.fmt.para_spacing = fmt->para_spacing;
    }
    if (fmt->word_spacing > -20.0f && fmt->word_spacing < 200.0f) {
        p.fmt.word_spacing = fmt->word_spacing;
    }
    if (fmt->first_indent >= 0.0f && fmt->first_indent < 500.0f) {
        p.fmt.first_indent = fmt->first_indent;
    }
    if (fmt->hang_indent >= 0.0f && fmt->hang_indent < 500.0f) {
        p.fmt.hang_indent = fmt->hang_indent;
    }
    p.fmt.dir = (fmt->dir >= 0 && fmt->dir <= 2) ? fmt->dir : 0;
    p.fmt.list_level = std::max(0, std::min(8, fmt->list_level));
}

}

void ec::pinSourceBreaks(const Paragraph& src, Paragraph& out) {
    out.pinnedBreaks.clear();
    out.pinWhy = 0;

    if (src.vertical || src.lines.empty() || src.runs.empty()) { out.pinWhy = 1; return; }
    if (std::abs(out.width - src.width) > 0.01f) { out.pinWhy = 2; return; }
    const ec_para_format &a = src.fmt, &b = out.fmt;

    if (std::abs(a.char_spacing - b.char_spacing) > 0.001f ||
        std::abs(a.word_spacing - b.word_spacing) > 0.001f ||
        std::abs(a.first_indent - b.first_indent) > 0.001f ||
        std::abs(a.hang_indent - b.hang_indent) > 0.001f ||
        a.dir != b.dir || a.list_level != b.list_level) {
        out.pinWhy = 3;
        return;
    }

    struct MetricKey {
        const std::string* family;
        float size, hScale, rise;
        int bold, italic, script, atomic;
        bool operator!=(const MetricKey& o) const {
            return *family != *o.family || bold != o.bold || italic != o.italic ||
                   script != o.script || atomic != o.atomic ||
                   std::abs(size - o.size) > 0.002f * std::max(1.0f, size) ||
                   std::abs(hScale - o.hScale) > 0.002f ||
                   std::abs(rise - o.rise) > 0.01f;
        }
    };
    auto keys = [](const std::vector<ParaRun>& rs, std::u16string& text) {
        std::vector<MetricKey> out2;
        for (const auto& r : rs) {
            MetricKey k{&r.style.family, r.style.size, r.style.hScale,
                        r.style.rise, r.style.bold ? 1 : (r.style.fauxBold ? 2 : 0),
                        r.style.italic ? 1 : (r.style.fauxItalic ? 2 : 0),
                        r.style.script, 0};
            for (char16_t ch : r.text) {

                k.atomic = (ch == u'\uFFFC' && r.atomicObject) ? 1 : 0;
                out2.push_back(k);
            }
            text += r.text;
        }
        return out2;
    };
    std::u16string ta, tb;
    const std::vector<MetricKey> ka = keys(src.runs, ta);
    const std::vector<MetricKey> kb = keys(out.runs, tb);
    if (ta != tb) { out.pinWhy = 4; return; }
    if (ka.size() != kb.size()) { out.pinWhy = 5; return; }
    for (size_t i = 0; i < ka.size(); i++)
        if (ka[i] != kb[i]) { out.pinWhy = 5; return; }

    long prev = -1;
    for (const LineInfo& L : src.lines) {
        if (L.off < prev || L.off > static_cast<long>(ta.size())) {
            out.pinnedBreaks.clear();
            out.pinWhy = 6;
            return;
        }
        prev = L.off;
        out.pinnedBreaks.push_back(L.off);
    }

    if (out.pinnedBreaks.size() > 1 && out.pinnedBreaks.back() == 0) {
        out.pinnedBreaks.clear();
        out.pinWhy = 6;
    }
}

namespace {

void inheritOriginalFonts(const Paragraph& oldPara, Paragraph& newPara) {
    for (auto& nr : newPara.runs) {
        if (nr.originalFont) continue;
        for (const auto& orun : oldPara.runs) {
            if (orun.atomicObject) continue;
            if (orun.originalFont && orun.style.sameTypeface(nr.style) &&
                (orun.text == nr.text || textProvablyCovered(nr.text, orun.text))) {
                nr.originalFont = orun.originalFont;
                nr.textUnchanged = true;
                if (nr.srcAdv.empty()) {
                    nr.srcAdv = sliceSrcAdv(orun, nr.text);
                    const float hs0 =
                        orun.style.hScale > 0.01f ? orun.style.hScale : 1.0f;
                    const float hs1 =
                        nr.style.hScale > 0.01f ? nr.style.hScale : 1.0f;
                    const float k =
                        (nr.style.size / std::max(0.5f, orun.style.size)) *
                        (hs1 / hs0);
                    if (std::abs(k - 1.0f) > 0.001f)
                        for (float& a : nr.srcAdv)
                            if (a > 0) a *= k;
                }
                break;
            }
        }
    }
}

int pageNextMcid(FPDF_PAGE page) {
    int maxM = -1;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        const int nm = FPDFPageObj_CountMarks(o);
        for (int k = 0; k < nm; k++) {
            FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(o, k);
            int v = 0;
            if (mk && FPDFPageObjMark_GetParamIntValue(mk, "MCID", &v))
                maxM = std::max(maxM, v);
        }
    }
    return maxM + 1;
}

void tagNewParagraph(Session* s, FPDF_PAGE page, Paragraph& p) {
    FPDF_STRUCTTREE st = FPDF_StructTree_GetForPage(page);
    const bool tagged = st && FPDF_StructTree_CountChildren(st) > 0;
    if (st) FPDF_StructTree_Close(st);
    if (!tagged) return;
    const int mcid = pageNextMcid(page);
    for (auto& oo : p.objects) {
        if (oo.container || oo.preserved) continue;

        if (FPDFPageObj_GetType(oo.object) != FPDF_PAGEOBJ_TEXT) continue;
        const int existing = FPDFPageObj_CountMarks(oo.object);
        bool hasP = false;
        FPDF_PAGEOBJECTMARK artifact = nullptr;
        for (int k = 0; k < existing; k++) {
            FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(oo.object, k);
            unsigned short nb[16] = {0};
            unsigned long got = 0;
            if (!mk || !FPDFPageObjMark_GetName(mk, nb, sizeof(nb), &got))
                continue;
            if (nb[0] == 'P' && nb[1] == 0) hasP = true;

            if (nb[0] == 'A' && nb[1] == 'r' && nb[2] == 't' && nb[3] == 'i' &&
                nb[4] == 'f' && nb[5] == 'a' && nb[6] == 'c' && nb[7] == 't' &&
                nb[8] == 0)
                artifact = mk;
        }
        if (artifact) FPDFPageObj_RemoveMark(oo.object, artifact);
        if (hasP) continue;
        FPDF_PAGEOBJECTMARK mk = FPDFPageObj_AddMark(oo.object, "P");
        if (mk)
            FPDFPageObjMark_SetIntParam(s->doc, oo.object, mk, "MCID", mcid);
    }
}

}

extern "C" {

const char* ec_version(void) { return "EditCore 0.2.0"; }

void* ec_buffer_alloc(unsigned long size) { return malloc(size); }

void ec_string_free(char* s) { free(s); }

EC_SESSION ec_session_create(FPDF_DOCUMENT doc, ec_font_provider_fn provider,
                             void* provider_ctx) {
    if (!doc) return nullptr;
    auto* s = new Session();
    s->doc = doc;
    s->provider = provider;
    s->providerCtx = provider_ctx;
    return s;
}

void ec_session_destroy(EC_SESSION session) {
    if (Session* sx = asSession(session)) historyClear(*sx);
    if (asSession(session) && asSession(session)->form) {
        FPDFDOC_ExitFormFillEnvironment(asSession(session)->form);
        asSession(session)->form = nullptr;
    }
    Session* s = asSession(session);
    if (!s) return;
    for (auto& [key, font] : s->fontCache) {
        if (font) FPDFFont_Close(font);
    }
    delete s;
}

namespace {

void bakeTextObjectSpacing(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT o) {
    const auto glyphs = ec::readOrigGlyphs(o);
    if (glyphs.size() < 2) return;
    bool hasSpace = false;
    for (const auto& g : glyphs) {
        if (g.code == 32) hasSpace = true;

        if (std::abs(g.y - glyphs[0].y) > 1e-4f) return;
    }

    if (!hasSpace || std::abs(glyphs[0].x) > 1e-3f) return;

    FPDF_FONT font = FPDFTextObj_GetFont(o);
    float size = 0;
    if (!font || !FPDFTextObj_GetFontSize(o, &size) || size <= 0) return;

    std::vector<uint32_t> codes;
    std::vector<float> pos;
    codes.reserve(glyphs.size());
    pos.reserve(glyphs.size() - 1);
    for (size_t i = 0; i < glyphs.size(); i++) {
        codes.push_back(glyphs[i].code);
        if (i) pos.push_back(glyphs[i].x);
    }

    FPDF_PAGEOBJECT tw = FPDFPageObj_CreateTextObj(s.doc, font, size);
    if (!tw) return;
    if (!FPDFText_SetCharcodes(tw, codes.data(), codes.size())) {
        FPDFPageObj_Destroy(tw);
        return;
    }
    const auto natural = ec::readOrigGlyphs(tw);
    if (natural.size() != glyphs.size()) {
        FPDFPageObj_Destroy(tw);
        return;
    }
    float step = 0;
    bool stepKnown = false, ok = true;
    float prevDelta = 0;
    for (size_t i = 1; i < glyphs.size() && ok; i++) {
        const float d = glyphs[i].x - natural[i].x;
        const float jump = d - prevDelta;
        if (glyphs[i - 1].code == 32) {
            if (std::abs(jump) >= 0.004f) {
                if (!stepKnown) {
                    step = jump;
                    stepKnown = true;
                } else if (std::abs(jump - step) > 0.02f) {
                    ok = false;
                }
            }
        } else if (std::abs(jump) > 0.02f) {
            ok = false;
        }
        prevDelta = d;
    }
    if (!ok || !stepKnown) {
        FPDFPageObj_Destroy(tw);
        return;
    }

    if (!FPDFText_SetPositions(tw, pos.data(), pos.size())) {
        FPDFPageObj_Destroy(tw);
        return;
    }
    FS_MATRIX m;
    if (FPDFPageObj_GetMatrix(o, &m)) FPDFPageObj_SetMatrix(tw, &m);
    unsigned int r, g, b, a;
    if (FPDFPageObj_GetFillColor(o, &r, &g, &b, &a))
        FPDFPageObj_SetFillColor(tw, r, g, b, a);
    if (FPDFPageObj_GetStrokeColor(o, &r, &g, &b, &a))
        FPDFPageObj_SetStrokeColor(tw, r, g, b, a);
    float sw = 0;
    if (FPDFPageObj_GetStrokeWidth(o, &sw)) FPDFPageObj_SetStrokeWidth(tw, sw);
    const FPDF_TEXT_RENDERMODE rm = FPDFTextObj_GetTextRenderMode(o);
    if (rm != FPDF_TEXTRENDERMODE_UNKNOWN && rm != FPDF_TEXTRENDERMODE_FILL)
        FPDFTextObj_SetTextRenderMode(tw, rm);

    int index = -1;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        if (FPDFPage_GetObject(page, i) == o) {
            index = i;
            break;
        }
    }
    if (index < 0 || !FPDFPage_InsertObjectAtIndex(page, tw, index)) {
        FPDFPageObj_Destroy(tw);
        return;
    }
    if (FPDFPage_RemoveObject(page, o)) FPDFPageObj_Destroy(o);
}

FS_MATRIX composeMatrix(const FS_MATRIX& c, const FS_MATRIX& f) {

    return FS_MATRIX{c.a * f.a + c.b * f.c,
                     c.a * f.b + c.b * f.d,
                     c.c * f.a + c.d * f.c,
                     c.c * f.b + c.d * f.d,
                     c.e * f.a + c.f * f.c + f.e,
                     c.e * f.b + c.f * f.d + f.f};
}

bool isIdentity(const FS_MATRIX& m) {
    return std::abs(m.a - 1) < 1e-6f && std::abs(m.b) < 1e-6f &&
           std::abs(m.c) < 1e-6f && std::abs(m.d - 1) < 1e-6f &&
           std::abs(m.e) < 1e-6f && std::abs(m.f) < 1e-6f;
}

void copyPaintState(FPDF_PAGEOBJECT src, FPDF_PAGEOBJECT dst) {
    unsigned int r, g, b, a;
    if (FPDFPageObj_GetFillColor(src, &r, &g, &b, &a))
        FPDFPageObj_SetFillColor(dst, r, g, b, a);
    if (FPDFPageObj_GetStrokeColor(src, &r, &g, &b, &a))
        FPDFPageObj_SetStrokeColor(dst, r, g, b, a);
    float w = 0;
    if (FPDFPageObj_GetStrokeWidth(src, &w) && w > 0)
        FPDFPageObj_SetStrokeWidth(dst, w);
}

std::string baseFontName(FPDF_FONT font) {
    if (!font) return std::string();
    char buf[256];
    const size_t n = FPDFFont_GetBaseFontName(font, buf, sizeof(buf));
    if (n == 0 || n > sizeof(buf)) return std::string();
    return std::string(buf, strnlen(buf, n));
}

FPDF_PAGEOBJECT cloneTextChild(FPDF_DOCUMENT doc, FPDF_PAGEOBJECT src,
                               FPDF_TEXTPAGE tp, const FS_MATRIX& place) {
    FPDF_FONT font = FPDFTextObj_GetFont(src);
    float size = 0;
    if (!font || !FPDFTextObj_GetFontSize(src, &size) || size <= 0)
        return nullptr;
    FPDF_PAGEOBJECT obj = FPDFPageObj_CreateTextObj(doc, font, size);
    if (!obj) return nullptr;

    const auto glyphs = ec::readOrigGlyphs(src);
    float xShift = 0;
    bool flat = !glyphs.empty();
    for (const auto& gl : glyphs)
        if (std::abs(gl.y - glyphs[0].y) > 1e-4f) flat = false;
    if (flat) xShift = glyphs[0].x;

    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    FPDFPageObj_GetMatrix(src, &m);

    m.e += xShift * m.a;
    m.f += xShift * m.b;
    const FS_MATRIX finalMatrix = composeMatrix(m, place);
    FPDFPageObj_SetMatrix(obj, &finalMatrix);

    bool placed = false;
    if (flat) {
        std::vector<uint32_t> codes;
        std::vector<float> pos;
        codes.reserve(glyphs.size());
        for (size_t i = 0; i < glyphs.size(); i++) {
            codes.push_back(glyphs[i].code);
            if (i) pos.push_back(glyphs[i].x - glyphs[0].x);
        }
        if (FPDFText_SetCharcodes(obj, codes.data(), codes.size())) {

            if (!pos.empty())
                FPDFText_SetPositions(obj, pos.data(), pos.size());
            placed = true;
        }
    }
    if (!placed) {

        if (!tp) {
            FPDFPageObj_Destroy(obj);
            return nullptr;
        }
        const unsigned long n = FPDFTextObj_GetText(src, tp, nullptr, 0);
        if (n < 2) {
            FPDFPageObj_Destroy(obj);
            return nullptr;
        }
        std::vector<unsigned short> buf(n / 2 + 1, 0);
        FPDFTextObj_GetText(src, tp, buf.data(), n);
        if (!FPDFText_SetText(obj, buf.data())) {
            FPDFPageObj_Destroy(obj);
            return nullptr;
        }
    }

    copyPaintState(src, obj);
    const FPDF_TEXT_RENDERMODE rm = FPDFTextObj_GetTextRenderMode(src);
    if (rm != FPDF_TEXTRENDERMODE_UNKNOWN && rm != FPDF_TEXTRENDERMODE_FILL)
        FPDFTextObj_SetTextRenderMode(obj, rm);
    return obj;
}

FPDF_PAGEOBJECT clonePathChild(FPDF_PAGEOBJECT src) {
    const int n = FPDFPath_CountSegments(src);
    if (n <= 0) return nullptr;
    FPDF_PAGEOBJECT path = nullptr;
    for (int i = 0; i < n; i++) {
        FPDF_PATHSEGMENT seg = FPDFPath_GetPathSegment(src, i);
        if (!seg) continue;
        float x = 0, y = 0;
        if (!FPDFPathSegment_GetPoint(seg, &x, &y)) continue;
        const int type = FPDFPathSegment_GetType(seg);
        if (!path) {

            if (type != FPDF_SEGMENT_MOVETO) return nullptr;
            path = FPDFPageObj_CreateNewPath(x, y);
            if (!path) return nullptr;
        } else if (type == FPDF_SEGMENT_MOVETO) {
            FPDFPath_MoveTo(path, x, y);
        } else if (type == FPDF_SEGMENT_LINETO) {
            FPDFPath_LineTo(path, x, y);
        } else if (type == FPDF_SEGMENT_BEZIERTO) {

            float x2 = 0, y2 = 0, x3 = 0, y3 = 0;
            FPDF_PATHSEGMENT s2 =
                i + 1 < n ? FPDFPath_GetPathSegment(src, i + 1) : nullptr;
            FPDF_PATHSEGMENT s3 =
                i + 2 < n ? FPDFPath_GetPathSegment(src, i + 2) : nullptr;
            if (!s2 || !s3 ||
                FPDFPathSegment_GetType(s2) != FPDF_SEGMENT_BEZIERTO ||
                FPDFPathSegment_GetType(s3) != FPDF_SEGMENT_BEZIERTO ||
                !FPDFPathSegment_GetPoint(s2, &x2, &y2) ||
                !FPDFPathSegment_GetPoint(s3, &x3, &y3)) {
                FPDFPageObj_Destroy(path);
                return nullptr;
            }
            FPDFPath_BezierTo(path, x, y, x2, y2, x3, y3);
            if (FPDFPathSegment_GetClose(s3)) FPDFPath_Close(path);
            i += 2;
            continue;
        } else {
            FPDFPageObj_Destroy(path);
            return nullptr;
        }
        if (FPDFPathSegment_GetClose(seg)) FPDFPath_Close(path);
    }
    if (!path) return nullptr;
    int fillMode = 0;
    FPDF_BOOL stroke = 0;
    if (FPDFPath_GetDrawMode(src, &fillMode, &stroke))
        FPDFPath_SetDrawMode(path, fillMode, stroke);
    copyPaintState(src, path);
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    FPDFPageObj_GetMatrix(src, &m);
    FPDFPageObj_SetMatrix(path, &m);
    return path;
}

bool collectFormLeaves(FPDF_PAGEOBJECT form, const FS_MATRIX& parent, int depth,
                       std::vector<std::pair<FPDF_PAGEOBJECT, FS_MATRIX>>& out) {
    if (depth > 4) return false;
    FS_MATRIX fm{1, 0, 0, 1, 0, 0};
    FPDFPageObj_GetMatrix(form, &fm);
    const FS_MATRIX here = composeMatrix(fm, parent);
    const int n = FPDFFormObj_CountObjects(form);
    if (n <= 0) return false;
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT child =
            FPDFFormObj_GetObject(form, static_cast<unsigned long>(i));
        if (!child) return false;
        switch (FPDFPageObj_GetType(child)) {
            case FPDF_PAGEOBJ_PATH: {

                int fillMode = 0;
                FPDF_BOOL stroke = 0;
                unsigned int r, g, b, a;
                if (FPDFPath_GetDrawMode(child, &fillMode, &stroke) &&
                    fillMode != 0 &&
                    !FPDFPageObj_GetFillColor(child, &r, &g, &b, &a))
                    return false;
                out.push_back({child, here});
                break;
            }
            case FPDF_PAGEOBJ_TEXT:
                out.push_back({child, here});
                break;
            case FPDF_PAGEOBJ_FORM:
                if (!collectFormLeaves(child, here, depth + 1, out)) return false;
                break;
            default:
                return false;
        }
    }
    return !out.empty();
}

std::vector<uint8_t> renderPageRaster(FPDF_PAGE page, int w, int h) {
    std::vector<uint8_t> px;
    FPDF_BITMAP bmp = FPDFBitmap_Create(w, h, 1);
    if (!bmp) return px;
    FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xFFFFFFFF);
    FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, FPDF_ANNOT);
    if (auto* buf = static_cast<uint8_t*>(FPDFBitmap_GetBuffer(bmp))) {
        const int stride = FPDFBitmap_GetStride(bmp);
        px.assign(buf, buf + static_cast<size_t>(stride) * h);
    }
    FPDFBitmap_Destroy(bmp);
    return px;
}

double rasterDelta(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b) {
    if (a.empty() || a.size() != b.size()) return 1.0;
    size_t diff = 0;
    for (size_t i = 0; i < a.size(); i++) {
        if (std::abs(static_cast<int>(a[i]) - static_cast<int>(b[i])) > 8) diff++;
    }
    return static_cast<double>(diff) / static_cast<double>(a.size());
}

bool flattenOneForm(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT form,
                    const std::vector<uint8_t>& before, int rw, int rh) {
    int index = -1;
    const int total = FPDFPage_CountObjects(page);
    for (int i = 0; i < total; i++) {
        if (FPDFPage_GetObject(page, i) == form) {
            index = i;
            break;
        }
    }
    if (index < 0) return false;

    std::vector<std::pair<FPDF_PAGEOBJECT, FS_MATRIX>> leaves;
    const FS_MATRIX identity{1, 0, 0, 1, 0, 0};
    if (!collectFormLeaves(form, identity, 1, leaves)) return false;

    for (const auto& entry : leaves) {
        if (FPDFPageObj_GetType(entry.first) != FPDF_PAGEOBJ_TEXT) continue;
        FPDF_FONT f = FPDFTextObj_GetFont(entry.first);
        if (!f) continue;
        size_t dataLen = 0;
        FPDFFont_GetFontData(f, nullptr, 0, &dataLen);
        if (dataLen == 0 && baseFontName(f).empty()) return false;
    }

    {
        std::map<std::string, FPDF_FONT> pageFonts;
        for (int i = 0; i < total; i++) {
            FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
            if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_TEXT) continue;
            FPDF_FONT f = FPDFTextObj_GetFont(o);
            const std::string nm = baseFontName(f);
            if (!nm.empty()) pageFonts.emplace(nm, f);
        }
        for (const auto& entry : leaves) {
            if (FPDFPageObj_GetType(entry.first) != FPDF_PAGEOBJ_TEXT) continue;
            FPDF_FONT f = FPDFTextObj_GetFont(entry.first);
            const std::string nm = baseFontName(f);
            if (nm.empty()) continue;
            auto it = pageFonts.find(nm);
            if (it != pageFonts.end() && it->second != f) return false;
        }
    }

    for (const auto& entry : leaves) {
        if (!isIdentity(entry.second)) return false;
    }
    {

        float fl, fb, fr, ft;
        if (!FPDFPageObj_GetBounds(form, &fl, &fb, &fr, &ft)) return false;
        for (const auto& entry : leaves) {
            float l, b, r, t;
            if (!FPDFPageObj_GetBounds(entry.first, &l, &b, &r, &t)) return false;
            if (l < fl - 0.5f || b < fb - 0.5f || r > fr + 0.5f || t > ft + 0.5f)
                return false;
        }
    }

    int at = index;
    std::vector<FPDF_PAGEOBJECT> moved;
    for (const auto& entry : leaves) {
        FPDF_PAGEOBJECT child = entry.first;
        if (!FPDFFormObj_RemoveObject(form, child)) break;
        if (!FPDFPage_InsertObjectAtIndex(page, child, static_cast<size_t>(at++))) {
            FPDFPageObj_Destroy(child);
            break;
        }
        moved.push_back(child);
    }
    if (moved.size() != leaves.size()) return false;

    if (!FPDFPage_RemoveObject(page, form)) return false;
    FPDFPageObj_Destroy(form);

    const std::vector<uint8_t> after = renderPageRaster(page, rw, rh);
    return rasterDelta(before, after) <= 0.0002;
}

void flattenContentForms(Session& s, FPDF_PAGE page) {
    if (!s.flattenForms) return;
    std::vector<FPDF_PAGEOBJECT> forms;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (o && FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_FORM) forms.push_back(o);
    }
    if (forms.empty()) return;

    const int rw = static_cast<int>(FPDF_GetPageWidthF(page) * 1.5f);
    const int rh = static_cast<int>(FPDF_GetPageHeightF(page) * 1.5f);
    if (rw <= 0 || rh <= 0 || static_cast<long long>(rw) * rh > 40000000LL) return;
    for (FPDF_PAGEOBJECT form : forms) {
        const std::vector<uint8_t> before = renderPageRaster(page, rw, rh);
        if (before.empty()) return;
        flattenOneForm(s, page, form, before, rw, rh);
    }
}

void bakeWordSpacedText(Session& s, FPDF_PAGE page) {

    std::vector<FPDF_PAGEOBJECT> texts;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (o && FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_TEXT)
            texts.push_back(o);
    }
    for (FPDF_PAGEOBJECT o : texts) bakeTextObjectSpacing(s, page, o);
}

}

void ec_set_flatten_forms(EC_SESSION session, int enabled) {
    if (Session* s = asSession(session)) s->flattenForms = enabled != 0;
}

extern "C++" {
namespace ec {

void liveEndIfOpen(Session& s) {
    if (s.recording && s.recording->label == "__live_preview__")
        historyScratchRevert(s, s.recording->page);
    s.livePage = nullptr;
    s.livePara = -1;
    s.liveTicks = 0;
}

const Paragraph* livePristinePara(Session& s, FPDF_PAGE page, int para_id) {
    if (!(s.recording && s.recording->label == "__live_preview__" &&
          s.livePage == page && s.livePara == para_id))
        return nullptr;
    for (const Paragraph& q : s.recording->before)
        if (q.id == para_id) return &q;
    return nullptr;
}

}
}

char* ec_build_page_model(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);

    flattenContentForms(*s, page);
    bakeWordSpacedText(*s, page);

    if ((!s->undoStack.empty() && s->undoStack.back().page != page) ||
        (!s->redoStack.empty() && s->redoStack.back().page != page)) {
        historyClear(*s);
    }
    s->pages[page] = buildPageModel(*s, page);
    const PageState& st = s->pages[page];
    std::string j = "{\"paragraphs\":[";
    for (size_t i = 0; i < st.paras.size(); i++) {
        if (i) j += ",";
        j += paragraphToJson(st.paras[i]);
    }
    j += "]}";
    return dupString(j);
}

int ec_spell_load(EC_SESSION session, const char* data, int len) {
    Session* s = asSession(session);
    if (!s || !data || len <= 0) return 0;
    s->dict.load(data, static_cast<size_t>(len));
    return static_cast<int>(s->dict.words.size());
}

char* ec_spell_check_page(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) {
        char* built = ec_build_page_model(session, page);
        if (built) ec_string_free(built);
        it = s->pages.find(page);
        if (it == s->pages.end()) return nullptr;
    }
    return dupString(spellCheckPage(*s, it->second));
}

char* ec_select_text(EC_SESSION session, FPDF_PAGE page, float x0, float y0,
                     float x1, float y1, int mode) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) {
        char* built = ec_build_page_model(session, page);
        if (built) ec_string_free(built);
        it = s->pages.find(page);
        if (it == s->pages.end()) return nullptr;
    }
    return dupString(selectText(it->second, x0, y0, x1, y1, mode));
}

char* ec_build_page_model_region(EC_SESSION session, FPDF_PAGE page,
                                 float x, float y, float w, float h) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);
    char* full = ec_build_page_model(session, page);
    if (!full) return nullptr;
    ec_string_free(full);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    PageState& st = it->second;
    const float x1 = x + w, y1 = y + h;
    std::string j = "{\"paragraphs\":[";
    bool first = true;
    for (const Paragraph& p : st.paras) {
        const float px1 = p.x + p.width, py0 = p.top - p.height;
        if (px1 < x || p.x > x1 || p.top < y || py0 > y1) continue;
        if (!first) j += ",";
        first = false;
        j += paragraphToJson(p);
    }
    j += "]}";
    return dupString(j);
}

namespace {

void appendNum(std::string& out, float v) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%.3f", v);
    std::string t(buf);
    while (!t.empty() && t.back() == '0') t.pop_back();
    if (!t.empty() && t.back() == '.') t.pop_back();
    out += t.empty() ? "0" : t;
}
}

char* ec_page_text_json(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) {
        char* built = ec_build_page_model(session, page);
        if (built) ec_string_free(built);
        it = s->pages.find(page);
        if (it == s->pages.end()) return nullptr;
    }
    const PageState& st = it->second;
    const float pw = FPDF_GetPageWidthF(page);
    const float ph = FPDF_GetPageHeightF(page);
    const std::vector<size_t> order = readingOrder(st);
    std::string text;
    std::string blocks;
    for (size_t k = 0; k < order.size(); k++) {
        const Paragraph& p = st.paras[order[k]];
        std::string t;
        for (const auto& r : p.runs) t += utf16ToUtf8(r.text);
        if (!blocks.empty()) blocks += ",";
        blocks += "{\"id\":" + std::to_string(p.id);
        blocks += ",\"role\":\"";
        blocks += paragraphRole(st, p, pw, ph);
        blocks += "\",\"rect\":{\"x\":";
        appendNum(blocks, p.x);
        blocks += ",\"y\":";
        appendNum(blocks, p.top - p.height);
        blocks += ",\"w\":";
        appendNum(blocks, p.width);
        blocks += ",\"h\":";
        appendNum(blocks, p.height);
        blocks += "},\"text\":\"";
        jsonEscapeInto(blocks, t);
        blocks += "\"}";
        if (!text.empty()) text += "\n";
        text += t;
    }
    std::string j = "{\"text\":\"";
    jsonEscapeInto(j, text);
    j += "\",\"blocks\":[" + blocks + "]}";
    return dupString(j);
}

int ec_get_paragraph_objects(EC_SESSION session, FPDF_PAGE page, int para_id,
                             FPDF_PAGEOBJECT* out, int capacity) {
    Session* s = asSession(session);
    if (!s) return 0;
    if (s) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return 0;
    Paragraph* p = it->second.find(para_id);
    if (!p) return 0;

    int total = 0;
    for (const OwnedObject& oo : p->objects) {
        if (!oo.preserved) total++;
    }
    if (out && capacity > 0) {
        int i = 0;
        for (const OwnedObject& oo : p->objects) {
            if (oo.preserved) continue;
            if (i >= capacity) break;
            out[i++] = oo.object;
        }
    }
    return total;
}

unsigned long ec_get_run_font_data(EC_SESSION session, FPDF_PAGE page,
                                   int para_id, int run_index,
                                   unsigned char* out, unsigned long capacity) {
    Session* s = asSession(session);
    if (!s) return 0;
    const Paragraph* p = livePristinePara(*s, page, para_id);
    if (!p) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return 0;
    if (!p) p = it->second.find(para_id);
    if (!p || run_index < 0 || run_index >= static_cast<int>(p->runs.size())) return 0;
    const ParaRun& rr = p->runs[static_cast<size_t>(run_index)];

    FPDF_FONT font = rr.originalFont ? rr.originalFont : rr.boundFont;
    if (!font) return 0;
    size_t needed = 0;
    if (!FPDFFont_GetFontData(font, nullptr, 0, &needed) || needed == 0) return 0;
    if (out && capacity > 0) {
        std::vector<uint8_t> buf(needed);
        size_t written = 0;
        if (FPDFFont_GetFontData(font, buf.data(), needed, &written) && written > 0) {
            size_t n = std::min(static_cast<size_t>(capacity), written);
            memcpy(out, buf.data(), n);
        }
    }
    return static_cast<unsigned long>(needed);
}

void ec_form_draw(EC_SESSION session, FPDF_PAGE page, FPDF_BITMAP bitmap,
                  int start_x, int start_y, int size_x, int size_y,
                  int rotate, int flags) {
    Session* s = asSession(session);
    if (!s || !page || !bitmap) return;
    if (!s->form) {
        s->formInfo.version = 2;
        s->form = FPDFDOC_InitFormFillEnvironment(s->doc, &s->formInfo);
        if (!s->form) return;

        FPDF_SetFormFieldHighlightAlpha(s->form, 0);
    }
    FORM_OnAfterLoadPage(page, s->form);
    FPDF_FFLDraw(s->form, bitmap, page, start_x, start_y, size_x, size_y,
                 rotate, flags);
}

void ec_page_crop_origin(EC_SESSION session, FPDF_PAGE page, float* x,
                         float* y) {
    if (x) *x = 0;
    if (y) *y = 0;
    Session* s = asSession(session);
    if (!s || !page) return;
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return;
    if (x) *x = it->second.cropX;
    if (y) *y = it->second.cropY;
}

void ec_page_transform(EC_SESSION session, FPDF_PAGE page, float* out6) {
    if (!out6) return;
    out6[0] = 1; out6[1] = 0; out6[2] = 0; out6[3] = 1; out6[4] = 0; out6[5] = 0;
    Session* s = asSession(session);
    if (!s || !page) return;

    PageState tmp;
    const PageState* stp = nullptr;
    auto it = s->pages.find(page);
    if (it != s->pages.end()) {
        stp = &it->second;
    } else {
        float ml = 0, mb = 0, mr = 0, mt = 0, cl = 0, cb = 0, cr2 = 0, ct = 0;
        const bool hasM = FPDFPage_GetMediaBox(page, &ml, &mb, &mr, &mt) != 0;
        const bool hasC = FPDFPage_GetCropBox(page, &cl, &cb, &cr2, &ct) != 0;
        if (hasC) { tmp.cropX = cl; tmp.cropY = cb; }
        else if (hasM) { tmp.cropX = ml; tmp.cropY = mb; }
        if (hasM && hasC) { tmp.cropX = std::max(cl, ml); tmp.cropY = std::max(cb, mb); }
        tmp.pageRot = FPDFPage_GetRotation(page) * 90;
        tmp.unrotW = std::abs(hasC ? (cr2 - cl) : (hasM ? (mr - ml) : 0.0f));
        tmp.unrotH = std::abs(hasC ? (ct - cb) : (hasM ? (mt - mb) : 0.0f));
        stp = &tmp;
    }
    const PageState& st = *stp;

    switch (((st.pageRot % 360) + 360) % 360) {
        case 90:
            out6[0] = 0;  out6[1] = -1; out6[2] = 1;  out6[3] = 0;
            out6[4] = -st.cropY;            out6[5] = st.unrotW + st.cropX;
            return;
        case 180:
            out6[0] = -1; out6[1] = 0;  out6[2] = 0;  out6[3] = -1;
            out6[4] = st.unrotW + st.cropX; out6[5] = st.unrotH + st.cropY;
            return;
        case 270:
            out6[0] = 0;  out6[1] = 1;  out6[2] = -1; out6[3] = 0;
            out6[4] = st.unrotH + st.cropY; out6[5] = -st.cropX;
            return;
        default:
            out6[0] = 1;  out6[1] = 0;  out6[2] = 0;  out6[3] = 1;
            out6[4] = -st.cropX;            out6[5] = -st.cropY;
            return;
    }
}

char* ec_preview_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                           const ec_run_in* runs, int run_count,
                           const ec_para_format* fmt) {
    Session* s = asSession(session);
    if (!s || !page || !runs || run_count <= 0) return nullptr;
    const Paragraph* base = livePristinePara(*s, page, para_id);
    if (!base) liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    if (!base) base = it->second.find(para_id);
    if (!base || base->vertical) return nullptr;

    Paragraph tmp = *base;
    tmp.objects.clear();
    tmp.flattenForms.clear();
    tmp.runs = runsFromInput(runs, run_count, &base->runs);
    inheritOriginalFonts(*base, tmp);
    applyFormat(tmp, fmt);
    if (tmp.runs.empty()) return nullptr;

    pinSourceBreaks(*base, tmp);

    std::string json;
    if (!layoutParagraph(*s, page, tmp,  true, &json) ||
        json.empty()) {
        return nullptr;
    }
    return dupString(json);
}

static char* commitParagraphImpl(Session* s, FPDF_PAGE page, int para_id,
                                 const ec_run_in* runs, int run_count,
                                 const ec_para_format* fmt,
                                 const Paragraph* srcOverride) {
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* p = it->second.find(para_id);
    if (!p) return nullptr;

    HistoryStep step(*s, page, "edit text");
    if (!p->editable) return nullptr;

    const Paragraph* src = srcOverride ? srcOverride : p;
    Paragraph updated = *p;
    updated.runs = runsFromInput(runs, run_count, &src->runs);

    {
        std::set<FPDF_PAGEOBJECT> kept;
        for (const auto& nr : updated.runs)
            if (nr.atomicObject) kept.insert(nr.atomicObject);
        for (const auto& orun : src->runs) {
            if (!orun.atomicObject || kept.count(orun.atomicObject)) continue;

            historyRemoveObject(*s, page, orun.atomicContainer,
                                orun.atomicObject);
            updated.objects.erase(
                std::remove_if(updated.objects.begin(), updated.objects.end(),
                               [&](const OwnedObject& oo) {
                                   return oo.object == orun.atomicObject;
                               }),
                updated.objects.end());
        }
    }

    if (p->sharesObjects) {
        std::set<FPDF_PAGEOBJECT> mineNow;
        for (const OwnedObject& oo : p->objects)
            if (oo.object && !oo.preserved) mineNow.insert(oo.object);
        for (Paragraph& q : it->second.paras) {
            if (q.id == p->id || !q.editable || q.vertical || q.runs.empty())
                continue;
            bool shares = false;
            for (const OwnedObject& oo : q.objects)
                if (oo.object && mineNow.count(oo.object)) { shares = true; break; }
            if (!shares) continue;

            q.objects.erase(std::remove_if(q.objects.begin(), q.objects.end(),
                                [&](const OwnedObject& oo) {
                                    return mineNow.count(oo.object) > 0;
                                }),
                            q.objects.end());

            pinSourceBreaks(q, q);
            layoutParagraph(*s, page, q,  false);
            q.sharesObjects = false;
        }
        p = it->second.find(para_id);
        if (!p) return nullptr;
        if (!srcOverride) src = p;
        updated.sharesObjects = false;
    }
    inheritOriginalFonts(*src, updated);
    applyFormat(updated, fmt);

    if (commitParagraphSurgical(*s, page, *p, updated.runs, updated)) {

        std::map<int, std::set<FPDF_PAGEOBJECT>> oldOwners;
        for (const Paragraph& q : it->second.paras) {
            auto& set = oldOwners[q.id];
            for (const OwnedObject& oo : q.objects)
                if (oo.object) set.insert(oo.object);
            for (const ParaRun& r : q.runs)
                if (r.atomicObject) set.insert(r.atomicObject);
        }
        PageState fresh = buildPageModel(*s, page);
        std::set<int> takenIds;
        for (Paragraph& q : fresh.paras) {
            int match = -1;
            for (const OwnedObject& oo : q.objects) {
                if (!oo.object) continue;
                for (const auto& [oid, setRef] : oldOwners) {
                    if (takenIds.count(oid)) continue;
                    if (setRef.count(oo.object)) { match = oid; break; }
                }
                if (match >= 0) break;
            }
            if (match >= 0) {
                q.id = match;
                takenIds.insert(match);
            }
        }
        it->second = std::move(fresh);
        Paragraph* now = it->second.find(para_id);
        if (!now) return nullptr;

        for (ParaRun& r : now->runs)
            if (r.originalFont && !r.boundFont) r.boundFont = r.originalFont;

        std::string j = paragraphToJson(*now);
        if (!j.empty() && j.front() == '{')
            j = "{\"surgical\":true," + j.substr(1);
        return dupString(j);
    }

    pinSourceBreaks(*src, updated);

    if (!layoutParagraph(*s, page, updated,  true)) return nullptr;
    *p = updated;
    return dupString(paragraphToJson(*p));
}

char* ec_commit_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                          const ec_run_in* runs, int run_count,
                          const ec_para_format* fmt) {
    Session* s = asSession(session);
    if (!s || !page || !runs || run_count < 0) return nullptr;
    liveEndIfOpen(*s);
    return commitParagraphImpl(s, page, para_id, runs, run_count, fmt, nullptr);
}

int ec_render_paragraph_live_end(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s) return 0;
    (void)page;
    const bool was = s->recording && s->recording->label == "__live_preview__";
    liveEndIfOpen(*s);
    return was ? 1 : 0;
}

unsigned char* ec_render_paragraph_live(EC_SESSION session, FPDF_PAGE page,
                                        int para_id, const ec_run_in* runs,
                                        int run_count,
                                        const ec_para_format* fmt, float scale,
                                        float mx, float my, float mw, float mh,
                                        int* out_w, int* out_h) {
    Session* s = asSession(session);
    if (out_w) *out_w = 0;
    if (out_h) *out_h = 0;
    if (!s || !page || !runs || run_count <= 0 || !out_w || !out_h)
        return nullptr;
    if (!(scale > 0.01f) || !(mw > 0) || !(mh > 0)) return nullptr;
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* p = it->second.find(para_id);
    if (!p || !p->editable || p->vertical) return nullptr;

    if (p->unwrapsForms) return nullptr;

    bool liveOpen = s->recording && s->recording->label == "__live_preview__";
    if (s->recording && !liveOpen) return nullptr;
    if (liveOpen &&
        (s->livePage != page || s->livePara != para_id || ++s->liveTicks >= 8)) {
        liveEndIfOpen(*s);
        liveOpen = false;
        p = it->second.find(para_id);
        if (!p || !p->editable || p->vertical || p->unwrapsForms) return nullptr;
    }

    const int w = static_cast<int>(std::lround(mw * scale));
    const int h = static_cast<int>(std::lround(mh * scale));
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || w * h > 33554432)
        return nullptr;

    if (!liveOpen) {
        historyBegin(*s, page, "__live_preview__");
        s->livePage = page;
        s->livePara = para_id;
        s->liveTicks = 0;
    }
    const Paragraph* pristine =
        liveOpen ? livePristinePara(*s, page, para_id) : nullptr;
    char* json =
        commitParagraphImpl(s, page, para_id, runs, run_count, fmt, pristine);
    if (!json) {
        liveEndIfOpen(*s);
        return nullptr;
    }
    unsigned char* out = nullptr;
    {
        free(json);
        FPDF_BITMAP bmp = FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, nullptr, 0);
        if (bmp) {
            FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);

            const int flags = 0x01 | 0x02 | 0x10;
            const int fullW = static_cast<int>(
                std::lround(FPDF_GetPageWidthF(page) * scale));
            const int fullH = static_cast<int>(
                std::lround(FPDF_GetPageHeightF(page) * scale));
            const int sx = -static_cast<int>(std::lround(mx * scale));
            const int sy = -static_cast<int>(std::lround(my * scale));
            FPDF_RenderPageBitmap(bmp, page, sx, sy, fullW, fullH, 0, flags);
            ec_form_draw(session, page, bmp, sx, sy, fullW, fullH, 0, flags);
            const uint8_t* buf =
                static_cast<const uint8_t*>(FPDFBitmap_GetBuffer(bmp));
            const int stride = FPDFBitmap_GetStride(bmp);
            if (buf && stride >= w * 4) {
                out = static_cast<unsigned char*>(
                    malloc(static_cast<size_t>(w) * h * 4));
                if (out) {
                    for (int y = 0; y < h; y++)
                        memcpy(out + static_cast<size_t>(y) * w * 4,
                               buf + static_cast<size_t>(y) * stride,
                               static_cast<size_t>(w) * 4);
                    *out_w = w;
                    *out_h = h;
                }
            }
            FPDFBitmap_Destroy(bmp);
        }
    }

    if (!out) liveEndIfOpen(*s);
    return out;
}

char* ec_add_paragraph(EC_SESSION session, FPDF_PAGE page, float x, float y_top,
                       float width, const ec_run_in* runs, int run_count,
                       const ec_para_format* fmt) {
    Session* s = asSession(session);
    if (!s || !page || !runs || run_count <= 0) return nullptr;
    liveEndIfOpen(*s);

    HistoryStep step(*s, page, "add text");
    Paragraph p;
    p.id = s->nextParaId++;
    p.x = x;
    p.top = y_top;
    p.width = std::max(20.0f, width);
    p.runs = runsFromInput(runs, run_count);
    applyFormat(p, fmt);
    if (p.runs.empty()) return nullptr;

    if (!layoutParagraph(*s, page, p)) return nullptr;
    tagNewParagraph(s, page, p);
    s->pages[page].paras.push_back(p);
    return dupString(paragraphToJson(s->pages[page].paras.back()));
}

char* ec_duplicate_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                             float dx, float dy) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* src = it->second.find(para_id);
    if (!src || !src->editable || src->runs.empty()) return nullptr;

    HistoryStep step(*s, page, "duplicate");
    Paragraph p;
    p.id = s->nextParaId++;
    p.x = src->x;
    p.top = src->top;
    p.width = src->width;
    p.rotation = src->rotation;
    p.fmt = src->fmt;

    p.runs = src->runs;

    p.runs.erase(std::remove_if(p.runs.begin(), p.runs.end(),
                                [](const ParaRun& r) {
                                    return r.atomicObject != nullptr;
                                }),
                 p.runs.end());
    if (p.runs.empty()) return nullptr;
    for (auto& r : p.runs) r.textUnchanged = r.originalFont != nullptr;

    float mdx = dx, mdy = dy;
    if (p.rotation != 0) {
        const float c = std::cos(p.rotation), sn = std::sin(p.rotation);
        mdx = dx * c + dy * sn;
        mdy = -dx * sn + dy * c;
    }
    p.x += mdx;
    p.top += mdy;
    if (!layoutParagraph(*s, page, p)) return nullptr;
    it->second.paras.push_back(std::move(p));
    return dupString(paragraphToJson(it->second.paras.back()));
}

int ec_clone_marker(EC_SESSION session, FPDF_PAGE page, int src_para_id,
                    int dst_para_id) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return 0;
    Paragraph* src = it->second.find(src_para_id);
    Paragraph* dst = it->second.find(dst_para_id);
    if (!src || !dst || !src->hasMarker || src->rotation != 0 || dst->rotation != 0)
        return 0;

    if (dealiasPageFonts(*s, page) > 0) {
        src = it->second.find(src_para_id);
        dst = it->second.find(dst_para_id);
        if (!src || !dst) return 0;
    }

    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    const float dx = dst->x - src->x;
    const float dy = dst->firstBaseline - src->firstBaseline;
    int cloned = 0;
    for (const OwnedObject& oo : src->objects) {
        if (!oo.preserved || oo.container) continue;
        FPDF_PAGEOBJECT tobj = oo.object;
        if (FPDFPageObj_GetType(tobj) != FPDF_PAGEOBJ_TEXT) continue;
        FPDF_FONT font = FPDFTextObj_GetFont(tobj);
        float size = 12.0f;
        FPDFTextObj_GetFontSize(tobj, &size);
        if (!font) continue;
        unsigned long len = tp ? FPDFTextObj_GetText(tobj, tp, nullptr, 0) : 0;
        if (len < 2) continue;
        std::vector<unsigned short> buf(len / 2 + 1, 0);
        FPDFTextObj_GetText(tobj, tp, buf.data(), len);
        FPDF_PAGEOBJECT nobj = FPDFPageObj_CreateTextObj(s->doc, font, size);
        if (!nobj) continue;
        if (!FPDFText_SetText(nobj, buf.data())) {
            FPDFPageObj_Destroy(nobj);
            continue;
        }
        unsigned int r = 0, g = 0, b = 0, a = 255;
        if (FPDFPageObj_GetFillColor(tobj, &r, &g, &b, &a))
            FPDFPageObj_SetFillColor(nobj, r, g, b, a);
        FS_MATRIX m{1, 0, 0, 1, 0, 0};
        FPDFPageObj_GetMatrix(tobj, &m);
        m.e += dx;
        m.f += dy;
        FPDFPageObj_SetMatrix(nobj, &m);
        FPDFPage_InsertObject(page, nobj);
        dst->objects.push_back({nobj, nullptr,  true});
        cloned++;
    }
    if (tp) FPDFText_ClosePage(tp);
    if (cloned) dst->hasMarker = true;
    return cloned > 0 ? 1 : 0;
}

char* ec_test_arabic(const char* utf8, int mode) {
    if (!utf8) return nullptr;
    std::u16string t = utf8ToUtf16(utf8);
    if (mode == 0) {
        bool prevJoins = false;
        shapeArabicInPlace(t, &prevJoins);
    } else {
        unshapeArabicInPlace(t);
    }
    return dupString(utf16ToUtf8(t));
}

char* ec_document_info(FPDF_DOCUMENT doc) {
    if (!doc) return nullptr;
    std::string j = "{\"pages\":" + std::to_string(FPDF_GetPageCount(doc));
    j += ",\"signatures\":" + std::to_string(FPDF_GetSignatureCount(doc));

    const int rev = FPDF_GetSecurityHandlerRevision(doc);
    j += ",\"encrypted\":";
    j += rev >= 0 ? "true" : "false";
    j += ",\"securityRevision\":" + std::to_string(rev);
    const unsigned long perms = FPDF_GetDocPermissions(doc);
    j += ",\"permissions\":" + std::to_string(static_cast<long long>(perms));
    j += ",\"canModify\":";
    j += (rev < 0 || (perms & 8)) ? "true" : "false";
    j += "}";
    return dupString(j);
}

char* ec_test_bidi(const char* utf8, int baseDir) {
    const std::u16string t = utf8ToUtf16(utf8 ? utf8 : "");
    const std::vector<uint8_t> lv = bidiLevels(t, baseDir);
    std::string j = "[";
    for (size_t i = 0; i < lv.size(); i++) {
        if (i) j += ",";
        j += std::to_string(lv[i]);
    }
    j += "]";
    return dupString(j);
}

char* ec_test_pagetext(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (!tp) return nullptr;
    const int n = FPDFText_CountChars(tp);
    std::string j = "[";
    for (int i = 0; i < n; i++) {
        unsigned int uc = FPDFText_GetUnicode(tp, i);
        FPDF_PAGEOBJECT obj = FPDFText_GetTextObject(tp, i);
        double x = 0, y = 0;
        FPDFText_GetCharOrigin(tp, i, &x, &y);
        if (i) j += ",";

        FS_RECTF lb{0, 0, 0, 0};
        FPDFText_GetLooseCharBox(tp, i, &lb);
        j += "[" + std::to_string(uc) + "," + (obj ? "1" : "0") + "," +
             std::to_string(static_cast<int>(x * 10)) + "," +
             std::to_string(static_cast<int>(lb.left * 10)) + "," +
             std::to_string(static_cast<int>(lb.right * 10)) + "]";
    }
    j += "]";
    FPDFText_ClosePage(tp);
    return dupString(j);
}

char* ec_test_paraadv(EC_SESSION session, FPDF_PAGE page, int para_id) {
    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* p = it->second.find(para_id);
    if (!p) return nullptr;
    std::string j = "[";
    for (size_t i = 0; i < p->runs.size(); i++) {
        if (i) j += ",";
        j += "{\"run\":" + std::to_string(i) + ",\"text\":\"";
        jsonEscapeInto(j, utf16ToUtf8(p->runs[i].text));
        j += "\",\"adv\":[";
        for (size_t k = 0; k < p->runs[i].srcAdv.size(); k++) {
            if (k) j += ",";
            char b[24];
            snprintf(b, sizeof(b), "%.2f", static_cast<double>(p->runs[i].srcAdv[k]));
            j += b;
        }
        j += "]}";
    }
    j += "]";
    return dupString(j);
}

int ec_move_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id, float dx,
                      float dy) {
    Session* s = asSession(session);
    if (!s) return 0;
    liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return 0;
    Paragraph* p = it->second.find(para_id);
    if (!p) return 0;

    HistoryStep step(*s, page, "move");

    dealiasPageFonts(*s, page);
    p = it->second.find(para_id);
    if (!p) return 0;

    {
        float udx = dx, udy = dy;
        it->second.deltaToUser(dx, dy, &udx, &udy);
        dx = udx;
        dy = udy;
    }
    for (const OwnedObject& oo : p->objects) {
        float ldx = dx;
        float ldy = dy;

        if (oo.container) {
            FS_MATRIX fm;
            if (FPDFPageObj_GetMatrix(oo.container, &fm)) {
                const float det = fm.a * fm.d - fm.b * fm.c;
                if (std::abs(det) > 1e-6f) {
                    ldx = (fm.d * dx - fm.c * dy) / det;
                    ldy = (-fm.b * dx + fm.a * dy) / det;
                }
            }
        }
        FS_MATRIX t{1, 0, 0, 1, ldx, ldy};

        FPDFPageObj_TransformClipPath(oo.object, 1, 0, 0, 1, ldx, ldy);
        FPDFPageObj_TransformF(oo.object, &t);
        historyRecordMove(*s, oo.object, ldx, ldy);
    }

    float mdx = dx, mdy = dy;
    if (p->rotation != 0) {
        const float c = std::cos(p->rotation), sn = std::sin(p->rotation);
        mdx = dx * c + dy * sn;
        mdy = -dx * sn + dy * c;
    }
    p->x += mdx;
    p->top += mdy;
    p->firstBaseline += mdy;
    for (auto& ln : p->lines) {
        ln.x += mdx;
        ln.baseline += mdy;
    }
    return 1;
}

char* ec_resize_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                          float new_width) {
    Session* s = asSession(session);
    if (!s || new_width < 20.0f) return nullptr;
    liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* p = it->second.find(para_id);
    if (!p) return nullptr;
    HistoryStep step(*s, page, "resize");

    Paragraph updated = *p;
    updated.width = new_width;
    if (!layoutParagraph(*s, page, updated)) return nullptr;
    *p = updated;
    return dupString(paragraphToJson(*p));
}

int ec_reencode_page_fonts(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    liveEndIfOpen(*s);

    if (s->saveTextOnly.count(page)) return 0;

    std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT> remap;
    const int rebuilt = reencodePageFonts(*s, page, &remap);
    if (rebuilt > 0 && !remap.empty()) {
        auto it = s->pages.find(page);
        if (it != s->pages.end()) {
            for (Paragraph& p : it->second.paras) {
                bool touched = false;
                for (OwnedObject& oo : p.objects) {
                    auto m = remap.find(oo.object);
                    if (m != remap.end()) {
                        oo.object = m->second;
                        touched = true;
                    }
                }
                if (touched) {

                    for (size_t ri = 0; ri < p.runs.size() && ri < p.objects.size(); ri++) {
                        if (FPDFPageObj_GetType(p.objects[ri].object) == FPDF_PAGEOBJ_TEXT) {
                            p.runs[ri].originalFont = FPDFTextObj_GetFont(p.objects[ri].object);
                        }
                    }
                }
            }
        }
    }
    return rebuilt;
}

int ec_dealias_page_fonts(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    liveEndIfOpen(*s);

    return dealiasPageFonts(*s, page);
}

void ec_set_surgical(EC_SESSION session, int enabled) {
    if (Session* s = asSession(session)) s->surgicalEnabled = enabled != 0;
}

char* ec_last_splice_plan(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page || s->undoStack.empty()) return nullptr;
    const EditCommand& cmd = s->undoStack.back();
    if (cmd.page != page) return nullptr;

    std::map<FPDF_PAGEOBJECT, std::vector<uint32_t>> keyOf;
    std::map<FPDF_PAGEOBJECT, std::pair<float, float>> shiftOf;
    std::vector<const EditOp*> removes, inserts;
    for (const EditOp& op : cmd.ops) {
        if (op.kind == EditOp::Kind::Charcodes) {
            if (!op.object) return nullptr;
            keyOf.emplace(op.object, op.codesBefore);
        } else if (op.kind == EditOp::Kind::Matrix) {
            if (!op.object) return nullptr;
            if (op.before.a != op.after.a || op.before.b != op.after.b ||
                op.before.c != op.after.c || op.before.d != op.after.d)
                return nullptr;
            auto& acc = shiftOf[op.object];
            acc.first += op.after.e - op.before.e;
            acc.second += op.after.f - op.before.f;
        } else if (op.kind == EditOp::Kind::Remove) {
            if (!op.object || op.container) return nullptr;
            removes.push_back(&op);
        } else if (op.kind == EditOp::Kind::Insert) {
            if (!op.object) return nullptr;
            inserts.push_back(&op);
        } else {
            return nullptr;
        }
    }
    const bool write = !removes.empty() || !inserts.empty();
    if (keyOf.empty() && !write) return nullptr;

    auto num = [](float v) {
        char b[40];
        snprintf(b, sizeof(b), "%.6g", static_cast<double>(v));
        return std::string(b);
    };
    auto codeList = [](const std::vector<uint32_t>& v) {
        std::string t;
        for (uint32_t c : v) { if (!t.empty()) t += ","; t += std::to_string(c); }
        return t;
    };

    auto naturalAdv = [&](FPDF_FONT font, float size, uint32_t code) -> float {
        FPDF_PAGEOBJECT tw = FPDFPageObj_CreateTextObj(s->doc, font, size);
        if (!tw) return -1;
        const uint32_t two[2] = {code, code};
        float adv = -1;
        if (FPDFText_SetCharcodes(tw, two, 2)) {
            const std::vector<ec::OrigGlyph> g = ec::readOrigGlyphs(tw);
            if (g.size() == 2 && g[1].x > g[0].x) adv = g[1].x - g[0].x;
        }
        FPDFPageObj_Destroy(tw);
        return adv;
    };

    std::string ops;
    for (const EditOp& op : cmd.ops) {
        if (op.kind != EditOp::Kind::Charcodes) continue;
        if (op.codesAfter.empty()) return nullptr;
        if (op.codesAfter.size() != op.posAfter.size()) return nullptr;
        FPDF_FONT font = FPDFTextObj_GetFont(op.object);
        float size = 0;
        FPDFTextObj_GetFontSize(op.object, &size);
        if (!font || size <= 0) return nullptr;
        std::string adv;
        for (uint32_t c : op.codesAfter) {
            const float a2 = naturalAdv(font, size, c);
            if (a2 < 0) return nullptr;
            if (!adv.empty()) adv += ",";
            adv += num(a2);
        }
        std::string pos;
        for (float x : op.posAfter) { if (!pos.empty()) pos += ","; pos += num(x); }
        FS_MATRIX m{1, 0, 0, 1, 0, 0};
        FPDFPageObj_GetMatrix(op.object, &m);
        const auto sh = shiftOf.find(op.object);
        const float dx = sh != shiftOf.end() ? sh->second.first : 0.0f;
        const float dy = sh != shiftOf.end() ? sh->second.second : 0.0f;
        if (!ops.empty()) ops += ",";
        ops += "{\"kind\":\"rebuild\",\"codes\":[" + codeList(op.codesBefore) +
               "],\"after\":[" + codeList(op.codesAfter) +
               "],\"pos\":[" + pos + "],\"adv\":[" + adv +
               "],\"dx\":" + num(dx) + ",\"dy\":" + num(dy) +
               ",\"size\":" + num(size) + ",\"tm\":[";
        for (float v : {m.a, m.b, m.c, m.d, m.e, m.f}) ops += num(v) + ",";
        ops.pop_back();
        ops += "]}";
    }

    for (const auto& [obj, d] : shiftOf) {
        if (keyOf.count(obj)) continue;
        if (d.first == 0 && d.second == 0) continue;
        const std::vector<uint32_t> key = readOrigCharcodes(obj);
        if (key.empty()) return nullptr;
        if (!ops.empty()) ops += ",";
        ops += "{\"kind\":\"tm\",\"codes\":[" + codeList(key) +
               "],\"dx\":" + num(d.first) + ",\"dy\":" + num(d.second) + "}";
    }

    if (write) {
        for (const EditOp* op : removes) {

            if (FPDFPageObj_GetType(op->object) != FPDF_PAGEOBJ_TEXT)
                return nullptr;
            const std::vector<uint32_t> key = readOrigCharcodes(op->object);
            if (key.empty()) return nullptr;
            FS_MATRIX m{1, 0, 0, 1, 0, 0};
            FPDFPageObj_GetMatrix(op->object, &m);
            if (!ops.empty()) ops += ",";
            ops += "{\"kind\":\"blank\",\"codes\":[" + codeList(key) +
                   "],\"tm\":[";
            for (float v : {m.a, m.b, m.c, m.d, m.e, m.f}) ops += num(v) + ",";
            ops.pop_back();
            ops += "]}";
        }
        for (const EditOp* op : inserts) {
            FPDF_PAGEOBJECT o = op->object;
            const int type = FPDFPageObj_GetType(o);
            unsigned int r = 0, g = 0, b = 0, a = 255;
            FPDFPageObj_GetFillColor(o, &r, &g, &b, &a);
            if (a != 255) return nullptr;
            FPDF_CLIPPATH clip = FPDFPageObj_GetClipPath(o);
            if (clip && FPDFClipPath_CountPaths(clip) > 0) return nullptr;
            if (type == FPDF_PAGEOBJ_PATH) {

                FS_MATRIX m{1, 0, 0, 1, 0, 0};
                FPDFPageObj_GetMatrix(o, &m);
                if (std::abs(m.b) > 1e-6f || std::abs(m.c) > 1e-6f)
                    return nullptr;
                int fillmode = 0, strokemode = 0;
                if (!FPDFPath_GetDrawMode(o, &fillmode, &strokemode) ||
                    !fillmode || strokemode)
                    return nullptr;
                float l = 0, bt = 0, rr2 = 0, tp = 0;
                if (!FPDFPageObj_GetBounds(o, &l, &bt, &rr2, &tp))
                    return nullptr;
                if (!ops.empty()) ops += ",";
                ops += "{\"kind\":\"rectdraw\",\"x\":" + num(l) +
                       ",\"y\":" + num(bt) + ",\"w\":" + num(rr2 - l) +
                       ",\"h\":" + num(tp - bt) + ",\"rgb\":[" +
                       std::to_string(r) + "," + std::to_string(g) + "," +
                       std::to_string(b) + "]}";
                continue;
            }
            if (type != FPDF_PAGEOBJ_TEXT) return nullptr;
            FPDF_FONT font = FPDFTextObj_GetFont(o);
            float size = 0;
            FPDFTextObj_GetFontSize(o, &size);
            if (!font || size <= 0) return nullptr;
            uint32_t fnum = ec::fontObjNum(*s, font);
            int wide = ec::fontIsType0(*s, font);

            std::string std14;
            if (!fnum) {
                char bn[128] = {0};
                FPDFFont_GetBaseFontName(font, bn, sizeof(bn));
                static const char* kStd14[] = {
                    "Helvetica", "Helvetica-Bold", "Helvetica-Oblique",
                    "Helvetica-BoldOblique", "Courier", "Courier-Bold",
                    "Courier-Oblique", "Courier-BoldOblique", "Times-Roman",
                    "Times-Bold", "Times-Italic", "Times-BoldItalic",
                    "Symbol", "ZapfDingbats"};
                for (const char* nm : kStd14)
                    if (std::strcmp(bn, nm) == 0) { std14 = nm; break; }
                if (std14.empty()) return nullptr;
                wide = 0;
            } else if (wide < 0) {
                return nullptr;
            }
            const std::vector<ec::OrigGlyph> gl = ec::readOrigGlyphs(o);
            if (gl.empty()) return nullptr;
            std::string codes, pos, adv;
            for (const ec::OrigGlyph& gg : gl) {
                if (gg.y != 0) return nullptr;
                if (!wide && gg.code > 255) return nullptr;
                const float a2 = naturalAdv(font, size, gg.code);
                if (a2 < 0) return nullptr;
                if (!codes.empty()) { codes += ","; pos += ","; adv += ","; }
                codes += std::to_string(gg.code);
                pos += num(gg.x);
                adv += num(a2);
            }
            FS_MATRIX m{1, 0, 0, 1, 0, 0};
            FPDFPageObj_GetMatrix(o, &m);
            const int mode = FPDFTextObj_GetTextRenderMode(o);
            unsigned int sr = 0, sg2 = 0, sb = 0, sa = 255;
            FPDFPageObj_GetStrokeColor(o, &sr, &sg2, &sb, &sa);
            float sw = 0;
            FPDFPageObj_GetStrokeWidth(o, &sw);
            if (!ops.empty()) ops += ",";
            ops += "{\"kind\":\"draw\",\"font\":" + std::to_string(fnum) +
                   (std14.empty() ? "" : ",\"std14\":\"" + std14 + "\"") +
                   ",\"wide\":" + std::to_string(wide) +
                   ",\"size\":" + num(size) + ",\"mode\":" +
                   std::to_string(mode > 0 ? mode : 0) + ",\"rgb\":[" +
                   std::to_string(r) + "," + std::to_string(g) + "," +
                   std::to_string(b) + "],\"srgb\":[" + std::to_string(sr) +
                   "," + std::to_string(sg2) + "," + std::to_string(sb) +
                   "],\"sw\":" + num(sw > 0 ? sw : 1.0f) +
                   ",\"codes\":[" + codes + "],\"pos\":[" + pos +
                   "],\"adv\":[" + adv + "],\"tm\":[";
            for (float v : {m.a, m.b, m.c, m.d, m.e, m.f}) ops += num(v) + ",";
            ops.pop_back();
            ops += "]}";
        }
    }
    if (ops.empty()) return nullptr;
    return dupString(std::string("{\"kind\":\"") +
                     (write ? "write" : "splice") + "\",\"ops\":[" + ops +
                     "]}");
}

void ec_mark_fonts_fragile(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (s && page) s->fontsFragile.insert(page);
}

int ec_page_has_cid_fonts(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    liveEndIfOpen(*s);
    return pageNeedsReencode(*s, page) ? 1 : 0;
}

char* ec_page_text_state(EC_SESSION session, FPDF_PAGE page) {

    Session* s = asSession(session);
    if (!s || !page) return nullptr;
    if (s) liveEndIfOpen(*s);

    struct Entry { FPDF_PAGEOBJECT o; FS_MATRIX m; int inForm; };
    std::vector<Entry> entries;
    auto compose = [](const FS_MATRIX& a, const FS_MATRIX& b) {
        FS_MATRIX r;
        r.a = a.a * b.a + a.b * b.c;
        r.b = a.a * b.b + a.b * b.d;
        r.c = a.c * b.a + a.d * b.c;
        r.d = a.c * b.b + a.d * b.d;
        r.e = a.e * b.a + a.f * b.c + b.e;
        r.f = a.e * b.b + a.f * b.d + b.f;
        return r;
    };
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (!o) continue;
        const int type = FPDFPageObj_GetType(o);
        if (type == FPDF_PAGEOBJ_TEXT) {
            FS_MATRIX m{1, 0, 0, 1, 0, 0};
            FPDFPageObj_GetMatrix(o, &m);
            entries.push_back({o, m, 0});
        } else if (type == FPDF_PAGEOBJ_FORM) {
            FS_MATRIX fm{1, 0, 0, 1, 0, 0};
            FPDFPageObj_GetMatrix(o, &fm);
            const int kids = FPDFFormObj_CountObjects(o);
            for (int k = 0; k < kids; k++) {
                FPDF_PAGEOBJECT kid =
                    FPDFFormObj_GetObject(o, static_cast<unsigned long>(k));
                if (!kid || FPDFPageObj_GetType(kid) != FPDF_PAGEOBJ_TEXT)
                    continue;
                FS_MATRIX km{1, 0, 0, 1, 0, 0};
                FPDFPageObj_GetMatrix(kid, &km);
                entries.push_back({kid, compose(km, fm), 1});
            }
        }
    }
    std::string j = "[";
    for (size_t ei = 0; ei < entries.size(); ei++) {
        FPDF_PAGEOBJECT o = entries[ei].o;
        const FS_MATRIX& m = entries[ei].m;
        float size = 0;
        FPDFTextObj_GetFontSize(o, &size);
        FPDF_FONT font = FPDFTextObj_GetFont(o);

        int t3 = 0;
        if (font) {
            size_t dataLen = 0;
            FPDFFont_GetFontData(font, nullptr, 0, &dataLen);
            char nameBuf[64] = {0};
            const unsigned long nameLen =
                FPDFFont_GetBaseFontName(font, nameBuf, sizeof(nameBuf));
            if (dataLen == 0 && nameLen <= 1) t3 = 1;
        }
        unsigned int fr = 0, fg = 0, fb = 0, fa = 255;
        FPDFPageObj_GetFillColor(o, &fr, &fg, &fb, &fa);
        unsigned int sr = 0, sg = 0, sb = 0, sa = 255;
        FPDFPageObj_GetStrokeColor(o, &sr, &sg, &sb, &sa);
        float sw = 0;
        FPDFPageObj_GetStrokeWidth(o, &sw);
        const int tr = static_cast<int>(FPDFTextObj_GetTextRenderMode(o));
        char head[352];
        snprintf(head, sizeof(head),
                 "%s{\"i\":%d,\"t3\":%d,\"inForm\":%d,\"size\":%.4f,\"font\":%llu,"
                 "\"fill\":[%u,%u,%u,%u],\"stroke\":[%u,%u,%u,%u],"
                 "\"sw\":%.4f,\"tr\":%d,"
                 "\"m\":[%.6f,%.6f,%.6f,%.6f,%.6f,%.6f],\"glyphs\":[",
                 j.size() > 1 ? "," : "", static_cast<int>(ei), t3,
                 entries[ei].inForm, size,
                 static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(font)),
                 fr, fg, fb, fa, sr, sg, sb, sa, sw, tr,
                 m.a, m.b, m.c, m.d, m.e, m.f);
        j += head;
        const std::vector<OrigGlyph> glyphs = readOrigGlyphs(o);
        for (size_t c = 0; c < glyphs.size(); c++) {
            char g[96];
            snprintf(g, sizeof(g), "%s[%u,%.4f,%.4f]", c ? "," : "",
                     glyphs[c].code, glyphs[c].x, glyphs[c].y);
            j += g;
        }
        j += "]}";
    }
    j += "]";
    return dupString(j);
}

namespace {

int normalizePaintRecursive(FPDF_PAGEOBJECT obj) {
    const int type = FPDFPageObj_GetType(obj);
    if (type == FPDF_PAGEOBJ_FORM) {
        int fixed = 0;
        const int n = FPDFFormObj_CountObjects(obj);
        for (int i = 0; i < n; i++) {
            FPDF_PAGEOBJECT child = FPDFFormObj_GetObject(obj, i);
            if (child) fixed += normalizePaintRecursive(child);
        }
        return fixed;
    }
    if (type != FPDF_PAGEOBJ_PATH && type != FPDF_PAGEOBJ_TEXT) return 0;
    int fixed = 0;
    unsigned int r = 0, g = 0, b = 0, a = 0;
    if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a)) {
        FPDFPageObj_SetFillColor(obj, r, g, b, a);
        fixed = 1;
    }
    if (FPDFPageObj_GetStrokeColor(obj, &r, &g, &b, &a)) {
        FPDFPageObj_SetStrokeColor(obj, r, g, b, a);
        fixed = 1;
    }
    return fixed;
}
}

int ec_normalize_page_paint(FPDF_PAGE page) {
    if (!page) return 0;
    int fixed = 0;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT obj = FPDFPage_GetObject(page, i);
        if (obj) fixed += normalizePaintRecursive(obj);
    }
    return fixed;
}

int ec_page_regen_is_lossy(EC_SESSION session, FPDF_PAGE page, int pageIndex) {
    Session* s = asSession(session);
    if (!s || !page || pageIndex < 0) return 0;
    liveEndIfOpen(*s);

    unsigned long n0 = 0;
    unsigned char* buf0 = ec_save_document(s->doc, 1, &n0);
    if (!buf0 || !n0) { if (buf0) ec_string_free(reinterpret_cast<char*>(buf0)); return 0; }

    auto printableCount = [](FPDF_PAGE p) {
        int n = 0;
        if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(p)) {
            const int c = FPDFText_CountChars(tp);
            for (int i = 0; i < c; i++) {
                const unsigned int uc = FPDFText_GetUnicode(tp, i);
                if (uc > 0x20 && uc != 0xFFFD && !(uc >= 0xE000 && uc <= 0xF8FF)) n++;
            }
            FPDFText_ClosePage(tp);
        }
        return n;
    };

    auto charBag = [](FPDF_PAGE p) {
        std::map<unsigned int, int> bag;
        if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(p)) {
            const int c = FPDFText_CountChars(tp);
            for (int i = 0; i < c; i++) {
                const unsigned int uc = FPDFText_GetUnicode(tp, i);
                if (uc > 0x20 && uc != 0xFFFD && !(uc >= 0xE000 && uc <= 0xF8FF))
                    bag[uc]++;
            }
            FPDFText_ClosePage(tp);
        }
        return bag;
    };
    auto bagDistance = [](const std::map<unsigned int, int>& a,
                          const std::map<unsigned int, int>& b) {
        int d = 0;
        for (const auto& [cp, n] : a) {
            auto it = b.find(cp);
            d += std::abs(n - (it == b.end() ? 0 : it->second));
        }
        for (const auto& [cp, n] : b)
            if (!a.count(cp)) d += n;
        return d;
    };

    int lossy = 0;
    FPDF_DOCUMENT d1 = FPDF_LoadMemDocument64(buf0, n0, nullptr);
    if (d1) {
        FPDF_PAGE p1 = FPDF_LoadPage(d1, pageIndex);
        if (p1) {
            const int before = printableCount(p1);
            const std::map<unsigned int, int> bagBefore = charBag(p1);
            if (before > 0) {

                FPDF_PAGEOBJECT victim = nullptr;
                for (int i = 0, n = FPDFPage_CountObjects(p1); i < n; i++) {
                    FPDF_PAGEOBJECT o = FPDFPage_GetObject(p1, i);
                    if (o && FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_TEXT) {
                        victim = o;
                        break;
                    }
                }
                int victimChars = 0;
                int reinserted = 0;
                if (victim) {
                    std::u16string victimText;
                    if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(p1)) {
                        const int c = FPDFText_CountChars(tp);
                        for (int i = 0; i < c; i++) {
                            if (FPDFText_GetTextObject(tp, i) != victim) continue;
                            const unsigned int uc = FPDFText_GetUnicode(tp, i);
                            if (uc > 0x20 && uc != 0xFFFD && !(uc >= 0xE000 && uc <= 0xF8FF))
                                victimChars++;
                            if (uc >= 0x20 && uc <= 0xFFFF)
                                victimText.push_back(static_cast<char16_t>(uc));
                        }
                        FPDFText_ClosePage(tp);
                    }

                    FPDF_FONT vfont = FPDFTextObj_GetFont(victim);
                    const float vsize = [&] {
                        float sz = 12.0f;
                        FPDFTextObj_GetFontSize(victim, &sz);
                        return sz > 0.5f ? sz : 12.0f;
                    }();
                    if (FPDFPage_RemoveObject(p1, victim)) FPDFPageObj_Destroy(victim);
                    if (vfont && !victimText.empty()) {
                        FPDF_PAGEOBJECT nu =
                            FPDFPageObj_CreateTextObj(d1, vfont, vsize);
                        if (nu) {
                            victimText.push_back(0);
                            if (FPDFText_SetText(
                                    nu, reinterpret_cast<FPDF_WIDESTRING>(
                                            victimText.data()))) {
                                FS_MATRIX mm{1, 0, 0, 1, 100, 100};
                                FPDFPageObj_SetMatrix(nu, &mm);
                                FPDFPage_InsertObject(p1, nu);
                                reinserted = victimChars;
                            } else {
                                FPDFPageObj_Destroy(nu);
                            }
                        }
                    }
                }

                ec_normalize_page_paint(p1);
                FPDFPage_GenerateContent(p1);
                const int expected = before - victimChars + reinserted;
                unsigned long n1 = 0;
                unsigned char* buf1 = ec_save_document(d1, 1, &n1);
                if (buf1 && n1 && expected > 0) {
                    FPDF_DOCUMENT d2 = FPDF_LoadMemDocument64(buf1, n1, nullptr);
                    if (d2) {
                        if (FPDF_PAGE p2 = FPDF_LoadPage(d2, pageIndex)) {
                            const int after = printableCount(p2);
                            lossy = (after * 10 < expected * 9) ? 1 : 0;

                            if (!lossy) {
                                const int dist =
                                    bagDistance(bagBefore, charBag(p2));
                                if (dist > std::max(6, before / 12)) lossy = 1;
                            }
                            FPDF_ClosePage(p2);
                        }
                        FPDF_CloseDocument(d2);
                    }
                }
                if (buf1) ec_string_free(reinterpret_cast<char*>(buf1));
            }
            FPDF_ClosePage(p1);
        }
        FPDF_CloseDocument(d1);
    }
    if (lossy) {

        int existingSafe = 0;
        FPDF_DOCUMENT d3 = FPDF_LoadMemDocument64(buf0, n0, nullptr);
        if (d3) {
            if (FPDF_PAGE p3 = FPDF_LoadPage(d3, pageIndex)) {
                const int before3 = printableCount(p3);
                std::map<unsigned int, int> bag3 = charBag(p3);
                FPDF_PAGEOBJECT victim = nullptr;
                for (int i = 0, n = FPDFPage_CountObjects(p3); i < n; i++) {
                    FPDF_PAGEOBJECT o = FPDFPage_GetObject(p3, i);
                    if (o && FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_TEXT) {
                        victim = o;
                        break;
                    }
                }
                int victimChars3 = 0;
                if (victim) {
                    if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(p3)) {
                        const int c = FPDFText_CountChars(tp);
                        for (int i = 0; i < c; i++) {
                            if (FPDFText_GetTextObject(tp, i) != victim) continue;
                            const unsigned int uc = FPDFText_GetUnicode(tp, i);
                            if (uc > 0x20 && uc != 0xFFFD &&
                                !(uc >= 0xE000 && uc <= 0xF8FF)) {
                                victimChars3++;
                                auto it = bag3.find(uc);
                                if (it != bag3.end() && --it->second == 0)
                                    bag3.erase(it);
                            }
                        }
                        FPDFText_ClosePage(tp);
                    }
                    if (FPDFPage_RemoveObject(p3, victim))
                        FPDFPageObj_Destroy(victim);
                }
                ec_normalize_page_paint(p3);
                FPDFPage_GenerateContent(p3);
                const int expected3 = before3 - victimChars3;
                unsigned long n4 = 0;
                unsigned char* buf4 = ec_save_document(d3, 1, &n4);
                if (buf4 && n4 && expected3 > 0) {
                    if (FPDF_DOCUMENT d4 = FPDF_LoadMemDocument64(buf4, n4, nullptr)) {
                        if (FPDF_PAGE p4 = FPDF_LoadPage(d4, pageIndex)) {
                            if (printableCount(p4) * 10 >= expected3 * 9 &&
                                bagDistance(bag3, charBag(p4)) <=
                                    std::max(6, expected3 / 12))
                                existingSafe = 1;
                            FPDF_ClosePage(p4);
                        }
                        FPDF_CloseDocument(d4);
                    }
                }
                if (buf4) ec_string_free(reinterpret_cast<char*>(buf4));
                FPDF_ClosePage(p3);
            }
            FPDF_CloseDocument(d3);
        }
        ec_string_free(reinterpret_cast<char*>(buf0));
        s->saveCorrupting.insert(page);
        if (existingSafe) s->saveTextOnly.insert(page);
        return existingSafe ? 3 : 1;
    }
    ec_string_free(reinterpret_cast<char*>(buf0));

    unsigned long nA = 0;
    unsigned char* bufA = ec_save_document(s->doc, 1, &nA);
    if (!bufA || !nA) { if (bufA) ec_string_free(reinterpret_cast<char*>(bufA)); return 0; }
    int renderLossy = 0;
    FPDF_DOCUMENT dA = FPDF_LoadMemDocument64(bufA, nA, nullptr);
    if (dA) {
        if (FPDF_PAGE pA = FPDF_LoadPage(dA, pageIndex)) {
            const int w = std::max(1, static_cast<int>(FPDF_GetPageWidthF(pA)));
            const int h = std::max(1, static_cast<int>(FPDF_GetPageHeightF(pA)));
            auto renderInk = [&](FPDF_PAGE pg, std::vector<uint8_t>& px) {
                FPDF_BITMAP bm = FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA,
                                                     nullptr, 0);
                if (!bm) return false;
                FPDFBitmap_FillRect(bm, 0, 0, w, h, 0xFFFFFFFF);
                FPDF_RenderPageBitmap(bm, pg, 0, 0, w, h, 0, 0);
                const uint8_t* buf = static_cast<const uint8_t*>(
                    FPDFBitmap_GetBuffer(bm));
                const int stride = FPDFBitmap_GetStride(bm);
                px.assign(static_cast<size_t>(w) * h, 0);
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                        px[static_cast<size_t>(y) * w + x] =
                            buf[y * stride + x * 4 + 1];
                FPDFBitmap_Destroy(bm);
                return true;
            };
            std::vector<uint8_t> before, after;
            if (renderInk(pA, before)) {
                ec_normalize_page_paint(pA);
                FPDFPage_GenerateContent(pA);
                unsigned long nB = 0;
                unsigned char* bufB = ec_save_document(dA, 1, &nB);
                if (bufB && nB) {
                    if (FPDF_DOCUMENT dB = FPDF_LoadMemDocument64(bufB, nB, nullptr)) {
                        if (FPDF_PAGE pB = FPDF_LoadPage(dB, pageIndex)) {
                            if (renderInk(pB, after) &&
                                after.size() == before.size()) {
                                size_t diff = 0;
                                for (size_t i = 0; i < before.size(); i++)
                                    if ((before[i] < 200) != (after[i] < 200))
                                        diff++;

                                if (diff > static_cast<size_t>(w + h) / 4)
                                    renderLossy = 2;
                            }
                            FPDF_ClosePage(pB);
                        }
                        FPDF_CloseDocument(dB);
                    }
                }
                if (bufB) ec_string_free(reinterpret_cast<char*>(bufB));
            }
            FPDF_ClosePage(pA);
        }
        FPDF_CloseDocument(dA);
    }
    ec_string_free(reinterpret_cast<char*>(bufA));
    return renderLossy;
}

namespace {

struct SaveBuffer {
    FPDF_FILEWRITE fw;
    std::vector<unsigned char> bytes;
};

int saveWriteBlock(FPDF_FILEWRITE* fw, const void* data, unsigned long size) {
    auto* sb = reinterpret_cast<SaveBuffer*>(fw);
    const auto* p = static_cast<const unsigned char*>(data);
    sb->bytes.insert(sb->bytes.end(), p, p + size);
    return 1;
}
}

unsigned char* ec_save_document(FPDF_DOCUMENT doc, int flags,
                                unsigned long* out_size) {
    if (out_size) *out_size = 0;
    if (!doc) return nullptr;

    auto saveWith = [&](FPDF_DWORD f, std::vector<uint8_t>& out) {
        SaveBuffer sb;
        sb.fw.version = 1;
        sb.fw.WriteBlock = saveWriteBlock;

        const bool okSave = (f & FPDF_INCREMENTAL)
                                ? FPDF_SaveWithVersion(doc, &sb.fw, f, 17)
                                : FPDF_SaveAsCopy(doc, &sb.fw, f);
        if (!okSave) return false;
        out = std::move(sb.bytes);
        return !out.empty();
    };

    auto pageText = [](FPDF_DOCUMENT d, int pi, size_t cap) {
        std::u16string t;
        FPDF_PAGE pg = FPDF_LoadPage(d, pi);
        if (!pg) return t;
        if (FPDF_TEXTPAGE tp = FPDFText_LoadPage(pg)) {
            const int n = FPDFText_CountChars(tp);
            for (int i = 0; i < n && t.size() < cap; i++) {
                const unsigned int uc = FPDFText_GetUnicode(tp, i);
                if (uc > 0x20 && uc != 0x00A0 && uc != 0x200B)
                    t.push_back(static_cast<char16_t>(uc & 0xFFFF));
            }
            FPDFText_ClosePage(tp);
        }
        FPDF_ClosePage(pg);
        return t;
    };
    std::vector<uint8_t> bytes;

    if (flags & FPDF_INCREMENTAL) {
        if (!saveWith(static_cast<FPDF_DWORD>(flags), bytes)) return nullptr;
        auto* outInc = static_cast<unsigned char*>(malloc(bytes.size()));
        if (!outInc) return nullptr;
        memcpy(outInc, bytes.data(), bytes.size());
        if (out_size) *out_size = static_cast<unsigned long>(bytes.size());
        return outInc;
    }

    flags |= FPDF_REMOVE_SECURITY;
    if (saveWith(static_cast<FPDF_DWORD>(flags) | FPDF_SUBSET_NEW_FONTS,
                 bytes)) {
        FPDF_DOCUMENT probe = FPDF_LoadMemDocument64(
            bytes.data(), bytes.size(), nullptr);
        bool ok = probe != nullptr;
        if (probe) {
            const int np = FPDF_GetPageCount(doc);
            for (int pi = 0; pi < np && ok; pi++) {
                ok = pageText(doc, pi, 20000) == pageText(probe, pi, 20000);
            }
            FPDF_CloseDocument(probe);
        }
        if (!ok) bytes.clear();
    }
    if (bytes.empty() &&
        !saveWith(static_cast<FPDF_DWORD>(flags), bytes)) {
        return nullptr;
    }

    {
        static const char kKey[] = "/ModDate";
        for (size_t i = 0; i + 32 < bytes.size(); i++) {
            if (memcmp(&bytes[i], kKey, sizeof(kKey) - 1) != 0) continue;
            size_t k = i + sizeof(kKey) - 1;
            while (k < bytes.size() && bytes[k] == ' ') k++;
            if (k + 18 >= bytes.size() || bytes[k] != '(' ||
                bytes[k + 1] != 'D' || bytes[k + 2] != ':')
                continue;
            bool digits = true;
            for (int d = 0; d < 14 && digits; d++)
                digits = bytes[k + 3 + d] >= '0' && bytes[k + 3 + d] <= '9';
            if (!digits) continue;
            const time_t now = time(nullptr);
            struct tm g {};
            gmtime_r(&now, &g);
            char stamp[16];
            snprintf(stamp, sizeof(stamp), "%04d%02d%02d%02d%02d%02d",
                     g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour,
                     g.tm_min, g.tm_sec);
            memcpy(&bytes[k + 3], stamp, 14);
            break;
        }
    }
    auto* out = static_cast<unsigned char*>(malloc(bytes.size()));
    if (!out) return nullptr;
    memcpy(out, bytes.data(), bytes.size());
    if (out_size) *out_size = static_cast<unsigned long>(bytes.size());
    return out;
}

void ec_history_begin(EC_SESSION session, FPDF_PAGE page, const char* label) {
    Session* s = asSession(session);
    if (!s || !page) return;
    s->historyDepth++;
    if (s->historyDepth == 1) historyBegin(*s, page, label);
}

void ec_history_end(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return;
    if (s->historyDepth > 0) s->historyDepth--;
    if (s->historyDepth == 0) historyEnd(*s, page);
}

int ec_history_undo(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    if (s) liveEndIfOpen(*s);
    return historyUndo(*s, page) ? 1 : 0;
}

int ec_history_redo(EC_SESSION session, FPDF_PAGE page) {
    Session* s = asSession(session);
    if (!s || !page) return 0;
    if (s) liveEndIfOpen(*s);
    return historyRedo(*s, page) ? 1 : 0;
}

FPDF_PAGE ec_history_next_page(EC_SESSION session, int which) {
    Session* s = asSession(session);
    if (!s) return nullptr;
    return historyNextPage(*s, which);
}

int ec_history_depth(EC_SESSION session, int which) {
    Session* s = asSession(session);
    if (!s) return 0;
    return static_cast<int>(which == 0 ? s->undoStack.size() : s->redoStack.size());
}

void ec_history_note_matrix(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    Session* s = asSession(session);
    if (!s || !page || !obj) return;
    historyNoteMatrix(*s, obj);
}

void ec_history_note_zorder(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    Session* s = asSession(session);
    if (!s || !page || !obj) return;
    historyNoteZOrder(*s, page, obj);
}

void ec_history_note_insert(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    Session* s = asSession(session);
    if (!s || !page || !obj) return;
    historyNoteInsert(*s, page, obj);
}

int ec_history_remove_object(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    Session* s = asSession(session);
    if (!s || !page || !obj) return 0;
    return historyRemoveObject(*s, page, nullptr, obj) ? 1 : 0;
}

void ec_history_clear(EC_SESSION session) {
    Session* s = asSession(session);
    if (!s) return;
    s->historyDepth = 0;
    historyClear(*s);
}

int ec_delete_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id) {
    Session* s = asSession(session);
    if (!s) return 0;
    liveEndIfOpen(*s);
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return 0;
    PageState& st = it->second;
    Paragraph* p = st.find(para_id);
    if (!p) return 0;

    HistoryStep step(*s, page, "delete");
    for (const OwnedObject& oo : p->objects) {
        historyRemoveObject(*s, page, oo.container, oo.object);
    }
    st.paras.erase(
        std::remove_if(st.paras.begin(), st.paras.end(),
                       [para_id](const Paragraph& q) { return q.id == para_id; }),
        st.paras.end());
    return 1;
}

}


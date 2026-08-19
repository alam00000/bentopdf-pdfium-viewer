#include "ec_internal.h"
#include "fpdf_transformpage.h"
#include "pdfium_internal.h"

namespace ec {

std::u16string utf8ToUtf16(const char* utf8) {
    std::u16string out;
    if (!utf8) return out;
    const unsigned char* p = reinterpret_cast<const unsigned char*>(utf8);
    while (*p) {
        uint32_t cp = 0;
        int extra = 0;
        if (*p < 0x80) {
            cp = *p;
        } else if ((*p >> 5) == 0x6) {
            cp = *p & 0x1F;
            extra = 1;
        } else if ((*p >> 4) == 0xE) {
            cp = *p & 0x0F;
            extra = 2;
        } else if ((*p >> 3) == 0x1E) {
            cp = *p & 0x07;
            extra = 3;
        } else {
            ++p;
            continue;
        }
        ++p;
        bool valid = true;
        for (int i = 0; i < extra; i++) {
            if ((*p >> 6) != 0x2) {
                valid = false;
                break;
            }
            cp = (cp << 6) | (*p & 0x3F);
            ++p;
        }
        if (!valid) continue;
        if (cp <= 0xFFFF) {
            out.push_back(static_cast<char16_t>(cp));
        } else {
            cp -= 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
        }
    }
    return out;
}

std::string utf16ToUtf8(const std::u16string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); i++) {
        uint32_t cp = s[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.size() && s[i + 1] >= 0xDC00 &&
            s[i + 1] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (s[i + 1] - 0xDC00);
            i++;
        }
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }
    return out;
}

void jsonEscapeInto(std::string& out, const std::string& utf8) {
    for (unsigned char c : utf8) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
}

namespace {

struct ArabicJoin {
    char16_t base;
    char16_t form0;
    uint8_t nforms;
};

const ArabicJoin kArabicJoins[] = {
    {0x0621, 0xFE80, 1}, {0x0622, 0xFE81, 2}, {0x0623, 0xFE83, 2},
    {0x0624, 0xFE85, 2}, {0x0625, 0xFE87, 2}, {0x0626, 0xFE89, 4},
    {0x0627, 0xFE8D, 2}, {0x0628, 0xFE8F, 4}, {0x0629, 0xFE93, 2},
    {0x062A, 0xFE95, 4}, {0x062B, 0xFE99, 4}, {0x062C, 0xFE9D, 4},
    {0x062D, 0xFEA1, 4}, {0x062E, 0xFEA5, 4}, {0x062F, 0xFEA9, 2},
    {0x0630, 0xFEAB, 2}, {0x0631, 0xFEAD, 2}, {0x0632, 0xFEAF, 2},
    {0x0633, 0xFEB1, 4}, {0x0634, 0xFEB5, 4}, {0x0635, 0xFEB9, 4},
    {0x0636, 0xFEBD, 4}, {0x0637, 0xFEC1, 4}, {0x0638, 0xFEC5, 4},
    {0x0639, 0xFEC9, 4}, {0x063A, 0xFECD, 4}, {0x0641, 0xFED1, 4},
    {0x0642, 0xFED5, 4}, {0x0643, 0xFED9, 4}, {0x0644, 0xFEDD, 4},
    {0x0645, 0xFEE1, 4}, {0x0646, 0xFEE5, 4}, {0x0647, 0xFEE9, 4},
    {0x0648, 0xFEED, 2}, {0x0649, 0xFEEF, 2}, {0x064A, 0xFEF1, 4},

    {0x0671, 0xFB50, 2},
    {0x067B, 0xFB52, 4}, {0x067E, 0xFB56, 4}, {0x0680, 0xFB5A, 4},
    {0x067A, 0xFB5E, 4}, {0x067F, 0xFB62, 4}, {0x0679, 0xFB66, 4},
    {0x06A4, 0xFB6A, 4}, {0x06A6, 0xFB6E, 4},
    {0x0684, 0xFB72, 4}, {0x0683, 0xFB76, 4}, {0x0686, 0xFB7A, 4},
    {0x0687, 0xFB7E, 4},
    {0x068D, 0xFB82, 2}, {0x068C, 0xFB84, 2}, {0x068E, 0xFB86, 2},
    {0x0688, 0xFB88, 2}, {0x0698, 0xFB8A, 2}, {0x0691, 0xFB8C, 2},
    {0x06A9, 0xFB8E, 4}, {0x06AF, 0xFB92, 4}, {0x06B3, 0xFB96, 4},
    {0x06B1, 0xFB9A, 4}, {0x06BA, 0xFB9E, 2}, {0x06BB, 0xFBA0, 4},
    {0x06C0, 0xFBA4, 2}, {0x06C1, 0xFBA6, 4}, {0x06BE, 0xFBAA, 4},
    {0x06D2, 0xFBAE, 2}, {0x06D3, 0xFBB0, 2},
    {0x06AD, 0xFBD3, 4}, {0x06C7, 0xFBD7, 2}, {0x06C6, 0xFBD9, 2},
    {0x06C8, 0xFBDB, 2}, {0x06CB, 0xFBDE, 2}, {0x06C5, 0xFBE0, 2},
    {0x06C9, 0xFBE2, 2}, {0x06D0, 0xFBE4, 4}, {0x06CC, 0xFBFC, 4},
};

const ArabicJoin* joinInfoForBase(char16_t c) {
    for (const auto& j : kArabicJoins) {
        if (j.base == c) return &j;
    }
    return nullptr;
}
const ArabicJoin* joinInfoForForm(char16_t c, int* formIndex) {
    for (const auto& j : kArabicJoins) {
        const int n = j.nforms == 1 ? 1 : j.nforms;
        if (c >= j.form0 && c < j.form0 + n) {
            *formIndex = c - j.form0;
            return &j;
        }
    }
    return nullptr;
}

bool isArabicTransparent(char16_t c) {
    return (c >= 0x064B && c <= 0x065F) || c == 0x0670;
}

}

bool isRtlChar(char16_t c) {
    return (c >= 0x0590 && c <= 0x08FF) || (c >= 0xFB1D && c <= 0xFDFF) ||
           (c >= 0xFE70 && c <= 0xFEFC);
}

bool textIsRtl(const std::u16string& t) {
    int rtl = 0, ltr = 0;
    for (char16_t c : t) {
        if (isRtlChar(c)) rtl++;
        else if ((c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') ||
                 (c >= 0x00C0 && c <= 0x024F) || (c >= 0x0370 && c <= 0x04FF)) ltr++;
    }
    return rtl > 0 && rtl >= ltr;
}

void unreverseGlyphClustersInPlace(std::u16string& text,
                                   const std::vector<float>& xs) {
    const size_t n = text.size();
    if (n < 2 || xs.size() != n) return;
    if (!textIsRtl(text)) return;
    size_t i = 0;
    while (i < n) {
        size_t j = i + 1;
        while (j < n && xs[j] > kNoOxShared && xs[i] > kNoOxShared &&
               std::abs(xs[j] - xs[i]) < 0.01f)
            j++;
        if (j - i >= 2 && j - i <= 4) {
            bool allRtl = true;
            for (size_t k = i; k < j; k++)
                if (!isRtlChar(text[k])) { allRtl = false; break; }
            if (allRtl) std::reverse(text.begin() + static_cast<long>(i),
                                     text.begin() + static_cast<long>(j));
        }
        i = j;
    }
}

bool unshapeArabicInPlace(std::u16string& t) {
    bool changed = false;
    std::u16string out;
    out.reserve(t.size() + 4);
    for (char16_t c : t) {

        if (c >= 0xFEF5 && c <= 0xFEFC) {
            static const char16_t alef[] = {0x0622, 0x0622, 0x0623, 0x0623,
                                            0x0625, 0x0625, 0x0627, 0x0627};
            out.push_back(0x0644);
            out.push_back(alef[c - 0xFEF5]);
            changed = true;
            continue;
        }
        int fi = 0;
        if (const ArabicJoin* j = joinInfoForForm(c, &fi)) {
            out.push_back(j->base);
            changed = true;
        } else {
            out.push_back(c);
        }
    }
    if (changed) t = std::move(out);
    return changed;
}

void shapeArabicInPlace(std::u16string& t, bool* prevJoins,
                        const std::function<bool(char16_t)>* canUseForm) {

    auto nextJoinable = [&](size_t i) {
        for (size_t k = i + 1; k < t.size(); k++) {
            if (isArabicTransparent(t[k])) continue;
            return joinInfoForBase(t[k]) != nullptr;
        }
        return false;
    };
    std::u16string out;
    out.reserve(t.size());
    for (size_t i = 0; i < t.size(); i++) {
        const char16_t c = t[i];
        if (isArabicTransparent(c)) { out.push_back(c); continue; }
        const ArabicJoin* j = joinInfoForBase(c);
        if (!j) { out.push_back(c); *prevJoins = false; continue; }

        if (c == 0x0644 && i + 1 < t.size()) {
            int ai = -1;
            switch (t[i + 1]) {
                case 0x0622: ai = 0; break;
                case 0x0623: ai = 1; break;
                case 0x0625: ai = 2; break;
                case 0x0627: ai = 3; break;
                default: break;
            }
            if (ai >= 0) {

                const char16_t lig = static_cast<char16_t>(
                    0xFEF5 + 2 * ai + (*prevJoins ? 1 : 0));
                if (!canUseForm || (*canUseForm)(lig)) {
                    out.push_back(lig);
                    i++;
                    *prevJoins = false;
                    continue;
                }
            }
        }
        const bool prev = *prevJoins;
        const bool next = j->nforms == 4 && nextJoinable(i);
        char16_t form = j->form0;
        if (j->nforms >= 2 && prev) form = j->form0 + 1;
        if (j->nforms == 4 && next) form = j->form0 + (prev ? 3 : 2);
        out.push_back(form);
        *prevJoins = j->nforms == 4;
    }
    t = std::move(out);
}

namespace {

struct ExtractedRun {
    FPDF_PAGEOBJECT object = nullptr;
    FPDF_PAGEOBJECT container = nullptr;
    std::u16string text;
    std::u16string trailingSeparator;

    int seq = 0;
    float baseline = 0;
    float startX = 0;
    float minX = 0, maxX = 0, minY = 0, maxY = 0;
    float size = 12;
    RunStyle style;
    FPDF_FONT font = nullptr;
    bool hasBounds = false;

    float rotation = 0;

    bool vertical = false;

    std::vector<float> tcSamples;

    std::vector<float> adv;

    std::vector<float> cx;

    int rtlAsc = 0;

    float prevOriginX = 0;
    uint32_t prevCp = 0;
    bool prevValid = false;

    size_t lastRealUnit = 0;
    float lastRealOx = 0;

    std::vector<float> wordStartOx;
    bool wordOpen = false;
    bool lastRealValid = false;

    int vertVotes = 0;
    int pairCount = 0;
    float lastRealOy = 0;

    void addBox(float l, float b, float r, float t) {
        if (!hasBounds) {
            minX = l; minY = b; maxX = r; maxY = t;
            hasBounds = true;
        } else {
            minX = std::min(minX, l);
            minY = std::min(minY, b);
            maxX = std::max(maxX, r);
            maxY = std::max(maxY, t);
        }
    }
};

constexpr float kNoOx = kNoOxShared;

bool isWhitespaceChar(char16_t c);

bool isCjkOrFullwidth(char16_t c) {
    return (c >= 0x2E80 && c <= 0x9FFF) ||
           (c >= 0xAC00 && c <= 0xD7AF) ||
           (c >= 0xF900 && c <= 0xFAFF) ||
           (c >= 0xFE30 && c <= 0xFE4F) ||
           (c >= 0xFF00 && c <= 0xFFEF);
}

bool isCombiningMark(char16_t c) {
    return (c >= 0x0300 && c <= 0x036F) || (c >= 0x0483 && c <= 0x0489) ||
           (c >= 0x0591 && c <= 0x05BD) || c == 0x05BF || c == 0x05C1 ||
           c == 0x05C2 || c == 0x05C4 || c == 0x05C5 || c == 0x05C7 ||
           (c >= 0x0610 && c <= 0x061A) || (c >= 0x064B && c <= 0x065F) ||
           c == 0x0670 || (c >= 0x06D6 && c <= 0x06DC) ||
           (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF) ||
           (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F);
}

void unreverseGlyphClusters(ExtractedRun& r) {
    unreverseGlyphClustersInPlace(r.text, r.cx);
}

void relogicalizeRtlRun(ExtractedRun& r) {
    if (r.rtlAsc < 1) return;
    const size_t n = r.text.size();
    if (n < 2 || r.cx.size() != n) return;

    if (r.hasBounds && r.maxY - r.minY > 1.9f * r.size) return;
    int rtl = 0;
    for (size_t i = 0; i < n; i++) {
        const char16_t c = r.text[i];
        if (c >= 0xD800 && c <= 0xDFFF) return;
        if (isArabicTransparent(c) || (c >= 0x0300 && c <= 0x036F) ||
            (c >= 0x0591 && c <= 0x05C7 && !isRtlChar(c)))
            return;
        if (isRtlChar(c)) { rtl++; continue; }
        if (isWhitespaceChar(c)) continue;

        if ((c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') ||
            (c >= u'0' && c <= u'9') || c >= 0x00C0)
            return;

    }
    if (rtl < 2) return;
    for (float x : r.cx)
        if (x <= kNoOx) return;

    std::vector<size_t> idx(n);
    for (size_t i = 0; i < n; i++) idx[i] = i;
    std::stable_sort(idx.begin(), idx.end(),
                     [&](size_t a, size_t b) { return r.cx[a] > r.cx[b]; });
    bool moved = false;
    for (size_t i = 0; i < n; i++) moved |= idx[i] != i;
    if (!moved) return;

    std::u16string out;
    out.reserve(n);
    std::vector<float> cx2;
    cx2.reserve(n);
    for (size_t k : idx) {
        out.push_back(r.text[k]);
        cx2.push_back(r.cx[k]);
    }
    r.text = std::move(out);
    r.cx = std::move(cx2);

    r.adv.clear();
    r.tcSamples.clear();
}

struct ExtractedLine {
    std::vector<ExtractedRun> runs;
    std::vector<FPDF_PAGEOBJECT> decorations;
    float baseline = 0;
    float minX = 0, maxX = 0, minY = 0, maxY = 0;
    float dominantSize = 12;
    float rotation = 0;
    bool rtl = false;

    bool invisible() const {
        if (runs.empty()) return false;
        for (const auto& r : runs)
            if (r.style.renderMode != 3) return false;
        return true;
    }

    void recompute() {
        if (runs.empty()) return;
        rotation = runs.front().rotation;

        int rtlRuns = 0, ltrRuns = 0;
        for (auto& r : runs) {
            if (textIsRtl(r.text)) {
                rtlRuns++;
                continue;
            }
            for (char16_t c : r.text) {
                if ((c >= u'A' && c <= u'Z') || (c >= u'a' && c <= u'z') ||
                    (c >= 0x00C0 && c <= 0x024F) ||
                    (c >= 0x0370 && c <= 0x04FF)) {
                    ltrRuns++;
                    break;
                }
            }
        }
        rtl = rtlRuns > 0 && rtlRuns > ltrRuns;
        minX = runs[0].minX; maxX = runs[0].maxX;
        minY = runs[0].minY; maxY = runs[0].maxY;
        float best = 0;
        for (auto& r : runs) {
            minX = std::min(minX, r.minX);
            maxX = std::max(maxX, r.maxX);
            minY = std::min(minY, r.minY);
            maxY = std::max(maxY, r.maxY);
            if (r.text.size() >= best) {
                best = static_cast<float>(r.text.size());
                dominantSize = r.size;

                baseline = r.baseline;
            }
        }
    }
};

static std::string cleanFamilyName(std::string name) {
    if (name.size() > 7 && name[6] == '+') {
        bool tag = true;
        for (int i = 0; i < 6; i++) {
            if (name[i] < 'A' || name[i] > 'Z') { tag = false; break; }
        }
        if (tag) name = name.substr(7);
    }
    const auto comma = name.find(',');
    if (comma != std::string::npos) name = name.substr(0, comma);
    for (const char* suf : {"-BoldItalic", "-BoldOblique", "-Bold", "-Italic",
                            "-Oblique", "-Regular", "-Roman"}) {
        const size_t n = strlen(suf), m = name.size();
        if (m > n && name.compare(m - n, n, suf) == 0) {
            name = name.substr(0, m - n);
            break;
        }
    }
    return name;
}

std::string fontFamilyName(FPDF_FONT font) {
    if (!font) return "";
    char buf[256] = {0};
    size_t n = FPDFFont_GetFamilyName(font, buf, sizeof(buf));
    if (n > 1) return cleanFamilyName(std::string(buf));
    n = FPDFFont_GetBaseFontName(font, buf, sizeof(buf));
    if (n <= 1) return "";
    std::string name = cleanFamilyName(std::string(buf));
    const auto dash = name.find('-');
    if (dash != std::string::npos) name = name.substr(0, dash);
    return name;
}

RunStyle styleFromObject(FPDF_PAGEOBJECT obj, FPDF_FONT font, float effectiveSize) {
    RunStyle st;
    st.size = effectiveSize;
    st.family = fontFamilyName(font);
    if (font) {
        int weight = FPDFFont_GetWeight(font);
        int flags = FPDFFont_GetFlags(font);

        st.bold = (weight >= 650) || (flags >= 0 && (flags & (1 << 18)));
        int angle = 0;
        st.italic = (FPDFFont_GetItalicAngle(font, &angle) && angle != 0) ||
                    (flags >= 0 && (flags & (1 << 6)));

        char buf[256] = {0};
        size_t nameLen = FPDFFont_GetBaseFontName(font, buf, sizeof(buf));
        if (nameLen > 1) {
            std::string name(buf);
            for (auto& c : name) c = static_cast<char>(tolower(c));
            if (name.find("bold") != std::string::npos) st.bold = true;
            if (name.find("italic") != std::string::npos ||
                name.find("oblique") != std::string::npos) {
                st.italic = true;
            }
        }
    }
    unsigned int r = 0, g = 0, b = 0, a = 255;
    if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a)) {
        st.rgba = (r << 24) | (g << 16) | (b << 8) | a;
    }

    const int rm = FPDFTextObj_GetTextRenderMode(obj);
    if (rm > 0) st.renderMode = rm;
    if (st.strokes()) {
        st.strokeRgba = st.rgba;
        unsigned int sr = 0, sg = 0, sb = 0, sa = 255;
        if (FPDFPageObj_GetStrokeColor(obj, &sr, &sg, &sb, &sa)) {
            st.strokeRgba = (sr << 24) | (sg << 16) | (sb << 8) | sa;
        }
        float sw = 1.0f;
        if (FPDFPageObj_GetStrokeWidth(obj, &sw) && sw > 0) st.strokeWidth = sw;

        if (!st.bold && rm == 2 && st.strokeRgba == st.rgba &&
            st.strokeWidth <= 0.06f * effectiveSize + 0.26f) {
            st.fauxBold = true;
            st.renderMode = 0;
        }
    }
    return st;
}

bool isWhitespaceChar(char16_t c) {
    return c == u' ' || c == u'\t' || c == 0x00A0 || c == 0x3000;
}

float nominalAdvance(FPDF_FONT font, uint32_t cp, float size) {
    float w = 0;
    if (font && FPDFFont_GetGlyphWidth(font, cp, size, &w) && w > 0) return w;
    return -1;
}

void appendUnicode(std::u16string& out, unsigned int cp) {
    if (cp <= 0xFFFF) {
        out.push_back(static_cast<char16_t>(cp));
    } else {
        unsigned int v = cp - 0x10000;
        out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
        out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
    }
}

}

PageState buildPageModel(Session& s, FPDF_PAGE page) {
    PageState state;

    s.docFontsByStyle.clear();

    {
        float ml = 0, mb = 0, mr = 0, mt = 0, cl = 0, cb = 0, cr2 = 0, ct = 0;
        const bool hasM = FPDFPage_GetMediaBox(page, &ml, &mb, &mr, &mt);
        const bool hasC = FPDFPage_GetCropBox(page, &cl, &cb, &cr2, &ct);
        float ox2 = 0, oy2 = 0;
        if (hasC) { ox2 = cl; oy2 = cb; }
        else if (hasM) { ox2 = ml; oy2 = mb; }
        if (hasM && hasC) { ox2 = std::max(cl, ml); oy2 = std::max(cb, mb); }
        state.cropX = ox2;
        state.cropY = oy2;

        state.pageRot = FPDFPage_GetRotation(page) * 90;
        const float cw = hasC ? (cr2 - cl) : (hasM ? (mr - ml) : 0.0f);
        const float ch = hasC ? (ct - cb) : (hasM ? (mt - mb) : 0.0f);
        state.unrotW = std::abs(cw);
        state.unrotH = std::abs(ch);
    }

    auto mapRect = [&state](float l, float b, float r, float t,
                            float* ox0, float* oy0, float* ox1, float* oy1) {
        float ax = 0, ay = 0, bx = 0, by = 0;
        state.toModel(l, b, &ax, &ay);
        state.toModel(r, t, &bx, &by);
        *ox0 = std::min(ax, bx);
        *oy0 = std::min(ay, by);
        *ox1 = std::max(ax, bx);
        *oy1 = std::max(ay, by);
    };
    auto mapX = [&state](float x, float y) { float a = 0, b2 = 0; state.toModel(x, y, &a, &b2); return a; };
    auto mapY = [&state](float x, float y) { float a = 0, b2 = 0; state.toModel(x, y, &a, &b2); return b2; };

    std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT> containerOf;
    std::vector<FPDF_PAGEOBJECT> pagePaths;

    std::map<FPDF_PAGEOBJECT, int> formChildCount;
    std::set<FPDF_PAGEOBJECT> pageLevelForms;

    std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT> formParent;
    std::set<FPDF_PAGEOBJECT> formShared;

    std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT> childSeenUnder;

    std::function<void(FPDF_PAGEOBJECT, int)> scanForm =
        [&](FPDF_PAGEOBJECT form, int depth) {
            if (depth > 4) return;
            const int n = FPDFFormObj_CountObjects(form);
            formChildCount[form] = n;
            for (int i = 0; i < n; i++) {
                FPDF_PAGEOBJECT child = FPDFFormObj_GetObject(form, static_cast<unsigned long>(i));
                if (!child) continue;
                auto seen = childSeenUnder.emplace(child, form);
                if (!seen.second && seen.first->second != form) {
                    formShared.insert(form);
                    formShared.insert(seen.first->second);
                }
                const int type = FPDFPageObj_GetType(child);
                if (type == FPDF_PAGEOBJ_TEXT) {
                    containerOf[child] = form;
                } else if (type == FPDF_PAGEOBJ_FORM) {
                    auto ins = formParent.emplace(child, form);
                    if (!ins.second && ins.first->second != form)
                        formShared.insert(child);

                    if (ins.second) scanForm(child, depth + 1);
                }
            }
        };

    const int objCount = FPDFPage_CountObjects(page);
    for (int i = 0; i < objCount; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (!o) continue;
        switch (FPDFPageObj_GetType(o)) {
            case FPDF_PAGEOBJ_TEXT: containerOf[o] = nullptr; break;
            case FPDF_PAGEOBJ_FORM:
                pageLevelForms.insert(o);
                scanForm(o, 1);
                break;
            case FPDF_PAGEOBJ_PATH: pagePaths.push_back(o); break;
            default: break;
        }
    }

    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (!tp) return state;

    {

        std::map<FPDF_FONT, std::unordered_map<uint32_t, uint32_t>> codeOwner;
        for (const auto& fe : s.fontUniToCode)
            for (const auto& uc : fe.second)
                codeOwner[fe.first].emplace(uc.second, uc.first);

        auto harvestTextObj = [&](FPDF_PAGEOBJECT o) {
            FPDF_FONT f = FPDFTextObj_GetFont(o);
            if (!f) return;
            const std::vector<uint32_t> codes = readOrigCharcodes(o);
            if (codes.empty() || codes.size() > 100000) return;
            std::vector<unsigned short> wbuf(codes.size() * 2 + 16);
            const unsigned long cap =
                static_cast<unsigned long>(wbuf.size() * 2);

            const unsigned long got = FPDFTextObj_GetText(o, tp, wbuf.data(), cap);

            if (got < 2 || got > cap) return;
            const size_t units = got / 2 - 1;

            std::vector<size_t> at;
            at.reserve(codes.size());
            if (units == codes.size()) {
                for (size_t k = 0; k < units; k++) at.push_back(k);
            } else {
                for (size_t k = 0; k < units; k++)
                    if (wbuf[k] != u' ') at.push_back(k);
                if (at.size() != codes.size()) return;
            }
            auto& enc = s.fontUniToCode[f];
            auto& owner = codeOwner[f];
            for (size_t k = 0; k < codes.size(); k++) {
                const uint32_t u = wbuf[at[k]];
                if (u == 0 || u == 0xFFFD) continue;

                auto oi = owner.find(codes[k]);
                if (oi != owner.end() && oi->second != u)
                    continue;

                if (enc.emplace(u, codes[k]).second)
                    owner.emplace(codes[k], u);
            }
        };

        std::set<FPDF_PAGEOBJECT> harvestedForms;
        std::function<void(FPDF_PAGEOBJECT, int)> harvestRec =
            [&](FPDF_PAGEOBJECT o, int depth) {
                const int type = FPDFPageObj_GetType(o);
                if (type == FPDF_PAGEOBJ_TEXT) {
                    harvestTextObj(o);
                } else if (type == FPDF_PAGEOBJ_FORM && depth < 12 &&
                           harvestedForms.insert(o).second) {
                    const int n = FPDFFormObj_CountObjects(o);
                    for (int i = 0; i < n; i++) {
                        FPDF_PAGEOBJECT c = FPDFFormObj_GetObject(
                            o, static_cast<unsigned long>(i));
                        if (c) harvestRec(c, depth + 1);
                    }
                }
            };
        const int nObj = FPDFPage_CountObjects(page);
        for (int i = 0; i < nObj; i++) {
            FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
            if (o) harvestRec(o, 0);
        }
    }

    std::map<FPDF_FONT, std::pair<int, int>> fontJunkStat;
    {
        const int pn = FPDFText_CountChars(tp);
        for (int i = 0; i < pn; i++) {
            const unsigned int uc0 = FPDFText_GetUnicode(tp, i);
            if (uc0 == u'\n' || uc0 == u'\r' || uc0 == u' ' || uc0 == 0x09)
                continue;
            FPDF_PAGEOBJECT o0 = FPDFText_GetTextObject(tp, i);
            if (!o0) continue;
            FPDF_FONT f0 = FPDFTextObj_GetFont(o0);
            if (!f0) continue;
            auto& st0 = fontJunkStat[f0];
            st0.second++;
            if (uc0 <= 0xFFFF &&
                (isUndecodableChar(static_cast<char16_t>(uc0)) || uc0 == 0xFF))
                st0.first++;
        }
    }
    auto fontIsJunk = [&](FPDF_FONT f0) {
        auto it0 = fontJunkStat.find(f0);
        return it0 != fontJunkStat.end() && it0->second.first >= 4 &&
               it0->second.first * 2 >= it0->second.second;
    };
    const int charCount = FPDFText_CountChars(tp);

    struct Gutter {
        float x0, x1, yTop, yBot;
    };
    std::vector<Gutter> gutters;

    std::vector<std::array<float, 3>> rowExtent;
    std::vector<std::pair<float, float>> tocBands;
    {
        struct Row {
            float y;
            std::vector<std::pair<float, float>> spans;
            int dots = 0;
            float rightX = -1e9f;
            bool endsDigit = false;
        };
        std::vector<Row> rows;
        for (int i = 0; i < charCount; i++) {
            const unsigned int uc = FPDFText_GetUnicode(tp, i);
            if (uc == 0x200B || uc <= 0x20) continue;
            double l = 0, r = 0, b = 0, t = 0;
            if (!FPDFText_GetCharBox(tp, i, &l, &r, &b, &t)) continue;
            float x0 = 0, y = 0, x1 = 0, yTop = 0;
            mapRect(static_cast<float>(l), static_cast<float>(b),
                    static_cast<float>(r), static_cast<float>(t), &x0, &y, &x1, &yTop);
            if (x1 - x0 <= 0.01f) continue;
            Row* row = nullptr;
            for (auto it = rows.rbegin(); it != rows.rend(); ++it) {
                if (std::abs(it->y - y) < 3.0f) {
                    row = &*it;
                    break;
                }
            }
            if (!row) {
                rows.push_back({y, {}, 0});
                row = &rows.back();
            }
            row->spans.push_back({x0, x1});
            if (uc == u'.') row->dots++;

            if (x1 > row->rightX) {
                row->rightX = x1;

                row->endsDigit = (uc >= u'0' && uc <= u'9') ||
                                 uc == u'i' || uc == u'v' || uc == u'x' ||
                                 uc == u'l' || uc == u'c' || uc == u'd' ||
                                 uc == u'm' || uc == u'I' || uc == u'V' ||
                                 uc == u'X' || uc == u'L' || uc == u'C' ||
                                 uc == u'D' || uc == u'M';
            }
        }
        for (const Row& r : rows) {
            float a2 = 1e9f, b3 = -1e9f;
            for (const auto& sp : r.spans) {
                a2 = std::min(a2, sp.first);
                b3 = std::max(b3, sp.second);
            }
            if (b3 > a2) rowExtent.push_back({r.y, a2, b3});
        }
        std::sort(rows.begin(), rows.end(),
                  [](const Row& a, const Row& b2) { return a.y > b2.y; });

        for (size_t i = 0; i < rows.size();) {
            if (!rows[i].endsDigit) { i++; continue; }
            size_t j = i + 1, last = i, hits = 1;
            float lo = rows[i].rightX, hi = rows[i].rightX;

            for (size_t miss = 0; j < rows.size() && miss <= 2; j++) {
                const bool fit = rows[j].endsDigit &&
                                 std::max(hi, rows[j].rightX) -
                                         std::min(lo, rows[j].rightX) <= 14.0f;
                if (!fit) { miss++; continue; }
                lo = std::min(lo, rows[j].rightX);
                hi = std::max(hi, rows[j].rightX);
                last = j;
                hits++;
                miss = 0;
            }
            j = last + 1;
            if (hits >= 5)
                tocBands.push_back({rows[last].y - 6.0f, rows[i].y + 6.0f});
            i = j;
        }
        struct Chain {
            float x0, x1, yTop, yBot;
            int n, miss;
        };
        std::vector<Chain> active;
        std::vector<Chain> shortChains;
        auto closeChain = [&](const Chain& c) {
            if (c.n >= 5 && c.x1 - c.x0 >= 4.0f) {
                gutters.push_back({c.x0, c.x1, c.yTop + 6.0f, c.yBot - 6.0f});
            } else if (c.n >= 2 && c.x1 - c.x0 >= 4.0f) {
                shortChains.push_back(c);
            }
        };
        for (auto& row : rows) {
            std::sort(row.spans.begin(), row.spans.end());

            std::vector<std::pair<float, float>> merged;
            for (auto& sp : row.spans) {
                if (!merged.empty() && sp.first <= merged.back().second + 1.2f) {
                    merged.back().second =
                        std::max(merged.back().second, sp.second);
                } else {
                    merged.push_back(sp);
                }
            }
            std::vector<std::pair<float, float>> gaps;
            if (row.spans.size() >= 6) {
                for (size_t k = 1; k < merged.size(); k++) {
                    const float g0 = merged[k - 1].second, g1 = merged[k].first;
                    if (g1 - g0 >= 4.0f) gaps.push_back({g0, g1});
                }

                if (row.dots >= 8 && row.dots * 4 >= static_cast<int>(row.spans.size())) {
                    gaps.clear();
                } else if (gaps.size() > 3) {
                    std::vector<std::pair<float, float>> wide;
                    for (auto& g : gaps)
                        if (g.second - g.first >= 8.0f) wide.push_back(g);
                    if (wide.size() <= 3) gaps = std::move(wide);
                    else gaps.clear();
                }
            }
            std::vector<char> gapUsed(gaps.size(), 0);
            for (auto& c : active) {
                bool tightened = false;
                for (size_t k = 0; k < gaps.size(); k++) {
                    const float ix0 = std::max(c.x0, gaps[k].first);
                    const float ix1 = std::min(c.x1, gaps[k].second);
                    if (ix1 - ix0 >= 4.0f) {
                        c.x0 = ix0;
                        c.x1 = ix1;
                        c.yBot = row.y;
                        c.n++;
                        c.miss = 0;
                        tightened = true;
                        gapUsed[k] = 1;
                        break;
                    }
                }
                if (!tightened) {

                    bool crossed = false;
                    for (auto& sp : merged) {
                        const float ov0 = std::max(sp.first, c.x0);
                        const float ov1 = std::min(sp.second, c.x1);
                        if (ov1 - ov0 >= 2.0f) {
                            crossed = true;
                            break;
                        }
                    }
                    if (crossed) c.miss++;
                    else c.yBot = row.y;
                }
            }
            for (size_t k = 0; k < gaps.size(); k++) {
                if (!gapUsed[k]) {
                    active.push_back(
                        {gaps[k].first, gaps[k].second, row.y, row.y, 1, 0});
                }
            }
            for (size_t k = active.size(); k-- > 0;) {
                if (active[k].miss > 1) {
                    closeChain(active[k]);
                    active.erase(active.begin() + static_cast<long>(k));
                }
            }
        }
        for (auto& c : active) closeChain(c);

        {
            const size_t accepted = gutters.size();
            for (const auto& c : shortChains) {
                for (size_t gi = 0; gi < accepted; gi++) {
                    const Gutter& g = gutters[gi];
                    const float ov0 = std::max(c.x0, g.x0);
                    const float ov1 = std::min(c.x1, g.x1);
                    if (ov1 - ov0 >= 3.0f) {
                        gutters.push_back(
                            {ov0, ov1, c.yTop + 6.0f, c.yBot - 6.0f});
                        break;
                    }
                }
            }
        }
    }

    {
        struct BRect { float x0, y0, x1, y1; };
        const float fudge = 4.0f;
        auto appendRect = [&](std::vector<BRect>& list, const BRect& b) {
            if (b.x1 - b.x0 <= 0.5f || b.y1 - b.y0 <= 0.5f) return;
            for (size_t i = 0; i < list.size();) {
                const BRect& r = list[i];
                if (b.x0 >= r.x0 - fudge && b.y0 >= r.y0 - fudge &&
                    b.x1 <= r.x1 + fudge && b.y1 <= r.y1 + fudge)
                    return;
                if (r.x0 >= b.x0 - fudge && r.y0 >= b.y0 - fudge &&
                    r.x1 <= b.x1 + fudge && r.y1 <= b.y1 + fudge) {
                    list[i] = list.back();
                    list.pop_back();
                    continue;
                }
                i++;
            }
            list.push_back(b);
        };
        const float pgW = FPDF_GetPageWidthF(page);
        const float pgH = FPDF_GetPageHeightF(page);
        auto feed = [&](std::vector<BRect>& list, const BRect& box) {
            std::vector<BRect> out;
            out.reserve(list.size() * 2);
            const BRect sides[4] = {
                {-1e5f, -1e5f, box.x0, 1e5f},   {box.x1, -1e5f, 1e5f, 1e5f},
                {-1e5f, -1e5f, 1e5f, box.y0},   {-1e5f, box.y1, 1e5f, 1e5f}};
            for (const BRect& r : list) {
                if (r.x1 <= box.x0 || r.x0 >= box.x1 || r.y1 <= box.y0 ||
                    r.y0 >= box.y1) {
                    appendRect(out, r);
                    continue;
                }
                for (const BRect& sd : sides) {
                    BRect c{std::max(r.x0, sd.x0), std::max(r.y0, sd.y0),
                            std::min(r.x1, sd.x1), std::min(r.y1, sd.y1)};
                    if (c.x1 > c.x0 && c.y1 > c.y0) appendRect(out, c);
                }
            }
            list = std::move(out);
        };
        std::vector<BRect> empties;
        empties.push_back({-2.0f, -2.0f, pgW + 2.0f, pgH + 2.0f});
        float feedDom = 12.0f;
        {
            struct WRow {
                float y;
                BRect all{1e9f, 1e9f, -1e9f, -1e9f};
                std::vector<BRect> words;
                int dots = 0, chars = 0;
            };
            std::vector<WRow> rows;
            auto rowAt = [&](float y) -> WRow& {
                for (auto it = rows.rbegin(); it != rows.rend(); ++it)
                    if (std::abs(it->y - y) < 3.0f) return *it;
                rows.push_back({y, {1e9f, 1e9f, -1e9f, -1e9f}, {}, 0, 0});
                return rows.back();
            };
            BRect w{0, 0, -1, -1};
            float wSize = 12.0f, wY = 0;
            bool have = false;
            std::vector<float> heights;
            auto flushWord = [&]() {
                if (!have) return;
                const float m = wSize / 4.0f;
                WRow& row = rowAt(wY);
                BRect pb{w.x0 - m, w.y0 - m, w.x1 + m, w.y1 + m};
                row.words.push_back(pb);
                row.all.x0 = std::min(row.all.x0, pb.x0);
                row.all.y0 = std::min(row.all.y0, pb.y0);
                row.all.x1 = std::max(row.all.x1, pb.x1);
                row.all.y1 = std::max(row.all.y1, pb.y1);
                heights.push_back(wSize);
                have = false;
            };
            for (int i = 0; i < charCount; i++) {
                const unsigned int uc = FPDFText_GetUnicode(tp, i);
                double l = 0, r = 0, b = 0, t = 0;
                if (uc <= 0x20 || uc == 0x200B ||
                    !FPDFText_GetCharBox(tp, i, &l, &r, &b, &t)) {
                    flushWord();
                    continue;
                }
                float x0 = 0, x1 = 0, y0 = 0, y1 = 0;
                mapRect(static_cast<float>(l), static_cast<float>(b),
                        static_cast<float>(r), static_cast<float>(t), &x0, &y0, &x1, &y1);
                if (x1 - x0 <= 0.01f) { flushWord(); continue; }
                if (have && std::abs(y0 - wY) >= 3.0f) flushWord();
                if (!have) {
                    w = {x0, y0, x1, y1};
                    wY = y0;
                    wSize = std::max(4.0f, y1 - y0);
                    have = true;
                } else {
                    w.x0 = std::min(w.x0, x0);
                    w.y0 = std::min(w.y0, y0);
                    w.x1 = std::max(w.x1, x1);
                    w.y1 = std::max(w.y1, y1);
                    wSize = std::max(wSize, y1 - y0);
                }
                WRow& row = rowAt(y0);
                row.chars++;
                if (uc == u'.') row.dots++;
            }
            flushWord();
            if (!heights.empty()) {
                std::sort(heights.begin(), heights.end());
                feedDom = heights[heights.size() / 2];
            }
            size_t budget = 0;
            for (auto& row : rows) {
                const bool leaderRow =
                    row.dots >= 8 && row.dots * 4 >= std::max(1, row.chars);
                if (leaderRow) {
                    feed(empties, row.all);
                    budget++;
                } else {
                    for (const BRect& wb : row.words) {
                        feed(empties, wb);
                        if (++budget > 30000) break;
                    }
                }
                if (empties.size() > 60000 || budget > 30000) break;
            }
        }
        {
            const float pageArea = pgW * pgH;
            const int nObj = FPDFPage_CountObjects(page);
            for (int i = 0; i < nObj && empties.size() < 60000; i++) {
                FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
                if (!o) continue;
                const int ty = FPDFPageObj_GetType(o);
                if (ty != FPDF_PAGEOBJ_IMAGE && ty != FPDF_PAGEOBJ_PATH)
                    continue;
                float l = 0, b = 0, r = 0, t = 0;
                if (!FPDFPageObj_GetBounds(o, &l, &b, &r, &t)) continue;
                mapRect(l, b, r, t, &l, &b, &r, &t);
                if ((r - l) * (t - b) > 0.3f * pageArea) continue;
                feed(empties, {l - 1.0f, b - 1.0f, r + 1.0f, t + 1.0f});
            }
        }
        const float minGutterW = std::max(6.0f, 0.6f * feedDom);

        std::function<void(BRect, int)> analyse = [&](BRect region, int depth) {
            BRect m = region;
            for (const BRect& r : empties) {
                BRect c{std::max(r.x0, region.x0), std::max(r.y0, region.y0),
                        std::min(r.x1, region.x1), std::min(r.y1, region.y1)};
                if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
                if (c.x0 <= m.x0 && c.y0 <= m.y0 && c.y1 >= m.y1)
                    m.x0 = std::max(m.x0, c.x1);
                else if (c.x1 >= m.x1 && c.y0 <= m.y0 && c.y1 >= m.y1)
                    m.x1 = std::min(m.x1, c.x0);
                else if (c.x0 <= m.x0 && c.x1 >= m.x1 && c.y0 <= m.y0)
                    m.y0 = std::max(m.y0, c.y1);
                else if (c.x0 <= m.x0 && c.x1 >= m.x1 && c.y1 >= m.y1)
                    m.y1 = std::min(m.y1, c.y0);
            }
            if (m.x1 - m.x0 < 24.0f || m.y1 - m.y0 < 16.0f || depth > 8) return;
            float vBest = 0, hBest = 0;
            BRect vCut{}, hCut{};
            for (const BRect& r : empties) {
                BRect c{std::max(r.x0, m.x0), std::max(r.y0, m.y0),
                        std::min(r.x1, m.x1), std::min(r.y1, m.y1)};
                if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
                if (c.y0 <= m.y0 && c.y1 >= m.y1 && c.x0 > m.x0 &&
                    c.x1 < m.x1 && c.x1 - c.x0 > vBest) {
                    vBest = c.x1 - c.x0;
                    vCut = c;
                }
                if (c.x0 <= m.x0 && c.x1 >= m.x1 && c.y0 > m.y0 &&
                    c.y1 < m.y1 && c.y1 - c.y0 > hBest) {
                    hBest = c.y1 - c.y0;
                    hCut = c;
                }
            }
            if (vBest >= minGutterW) {
                if (vBest >= 10.0f && (m.y1 - m.y0) >= 0.35f * pgH)
                    gutters.push_back({vCut.x0, vCut.x1, m.y1, m.y0});
                analyse({m.x0, m.y0, vCut.x0, m.y1}, depth + 1);
                analyse({vCut.x1, m.y0, m.x1, m.y1}, depth + 1);
            } else if (hBest >= 2.0f) {
                analyse({m.x0, hCut.y1, m.x1, m.y1}, depth + 1);
                analyse({m.x0, m.y0, m.x1, hCut.y0}, depth + 1);
            }
        };
        analyse({-2.0f, -2.0f, pgW + 2.0f, pgH + 2.0f}, 0);
    }

    for (const auto& t : tocBands) {
        for (Gutter& g : gutters) {
            if (g.yTop <= t.first || g.yBot >= t.second) continue;
            const float above = g.yTop - t.second;
            const float below = t.first - g.yBot;
            if (above <= 0 && below <= 0) { g.yTop = g.yBot; continue; }
            if (above >= below) g.yBot = std::max(g.yBot, t.second);
            else g.yTop = std::min(g.yTop, t.first);
        }
    }
    gutters.erase(std::remove_if(gutters.begin(), gutters.end(),
                                 [](const Gutter& g) {
                                     return g.yTop - g.yBot < 12.0f;
                                 }),
                  gutters.end());

    for (const Gutter& g : gutters)
        state.gutters.push_back({g.x0, g.x1, g.yTop, g.yBot});
    auto crossesGutter = [&](float a, float b2, float y) {
        if (b2 < a) std::swap(a, b2);
        for (auto& g : gutters) {
            if (y > g.yTop || y < g.yBot) continue;

            if (b2 > g.x1 - 1.0f && a < g.x1 - 2.0f && b2 - a >= 4.0f)
                return true;
        }
        return false;
    };

    std::vector<ExtractedRun> runs;
    ExtractedRun current;
    std::u16string pendingSep;
    bool active = false;

    auto flush = [&]() {
        if (active && !current.text.empty()) {

            current.vertical = current.pairCount >= 3 &&
                               current.vertVotes >= 3 &&
                               current.vertVotes * 10 >= current.pairCount * 7;

            unreverseGlyphClusters(current);
            relogicalizeRtlRun(current);

            if (unshapeArabicInPlace(current.text) || textIsRtl(current.text) ||
                current.adv.size() != current.text.size()) {
                current.adv.clear();
            }

            if (!textIsRtl(current.text) && current.wordStartOx.size() >= 2) {
                bool backwards = false, known = true;
                for (float v : current.wordStartOx) known &= v >= 0;
                for (size_t k = 1; known && k < current.wordStartOx.size(); k++)
                    if (current.wordStartOx[k] < current.wordStartOx[k - 1] - 0.5f)
                        backwards = true;
                if (known && backwards) {
                    std::vector<std::u16string> words;
                    std::u16string w;
                    for (char16_t c : current.text) {
                        if (isWhitespaceChar(c)) {
                            if (!w.empty()) {
                                words.push_back(w);
                                w.clear();
                            }
                        } else {
                            w.push_back(c);
                        }
                    }
                    if (!w.empty()) words.push_back(w);
                    if (words.size() == current.wordStartOx.size()) {
                        std::vector<size_t> idx(words.size());
                        for (size_t k = 0; k < idx.size(); k++) idx[k] = k;
                        std::stable_sort(idx.begin(), idx.end(),
                                         [&](size_t a2, size_t b2) {
                                             return current.wordStartOx[a2] <
                                                    current.wordStartOx[b2];
                                         });
                        std::u16string re;
                        for (size_t k = 0; k < idx.size(); k++) {
                            if (k) re.push_back(u' ');
                            re += words[idx[k]];
                        }
                        current.text = std::move(re);
                        current.adv.clear();
                    }
                }
            }
            current.seq = static_cast<int>(runs.size());
            if (getenv("EC_DEBUG_RUNS")) {
                std::string t8;
                for (char16_t c : current.text)
                    t8 += c < 128 ? static_cast<char>(c) : '?';
                fprintf(stderr, "[run] base %.1f x[%.1f..%.1f] \"%s\" sep=%d\n",
                        current.baseline, current.minX, current.maxX,
                        t8.c_str(), static_cast<int>(current.trailingSeparator.size()));
            }
            runs.push_back(current);
        }
        active = false;
        current = ExtractedRun();
    };

    std::map<FPDF_PAGEOBJECT, std::array<float, 4>> composedBounds;

    struct GeomFix {
        std::array<float, 4> bounds{};
        float e = 0, f = 0;
    };
    std::map<FPDF_PAGEOBJECT, GeomFix> geomFix;
    auto composedBoundsOf = [&](FPDF_PAGEOBJECT o,
                                FPDF_PAGEOBJECT form) -> const std::array<float, 4>* {
        auto it = composedBounds.find(o);
        if (it != composedBounds.end()) return &it->second;
        float l = 0, b = 0, r = 0, t = 0;
        if (!FPDFPageObj_GetBounds(o, &l, &b, &r, &t)) return nullptr;
        FS_MATRIX fm;
        if (form && FPDFPageObj_GetMatrix(form, &fm)) {
            const float xs[2] = {l, r}, ys[2] = {b, t};
            float nl = 1e9f, nb = 1e9f, nr = -1e9f, nt = -1e9f;
            for (float x : xs) {
                for (float y : ys) {
                    const float tx = fm.a * x + fm.c * y + fm.e;
                    const float ty = fm.b * x + fm.d * y + fm.f;
                    nl = std::min(nl, tx); nr = std::max(nr, tx);
                    nb = std::min(nb, ty); nt = std::max(nt, ty);
                }
            }
            l = nl; b = nb; r = nr; t = nt;
        }
        return &(composedBounds[o] = {l, b, r, t});
    };

    std::set<FPDF_FONT> lyingFonts;
    for (int i = 0; i < charCount; i++) {
        const unsigned int uc = FPDFText_GetUnicode(tp, i);
        if (uc <= u' ') continue;
        if (isUndecodableChar(static_cast<char16_t>(uc)) || uc == 0xFFFD) {
            FPDF_PAGEOBJECT o = FPDFText_GetTextObject(tp, i);
            FPDF_FONT f = o ? FPDFTextObj_GetFont(o) : nullptr;

            if (f && fontIsSubset(f)) lyingFonts.insert(f);
        }
    }

    std::map<int, std::u16string> decodeFix;
    {
        auto isGapSuspect = [](unsigned int u) {

            return u >= 0x00A0 && u < 0x0590;
        };
        bool anySuspect = false;
        for (int i = 0; i < charCount && !anySuspect; i++)
            anySuspect = isGapSuspect(FPDFText_GetUnicode(tp, i));
        if (anySuspect) {
            std::map<FPDF_PAGEOBJECT, std::vector<int>> byObject;
            for (int i = 0; i < charCount; i++) {
                FPDF_PAGEOBJECT o = FPDFText_GetTextObject(tp, i);
                if (o) byObject[o].push_back(i);
            }

            auto baseOf = [](char16_t c) {
                std::u16string one(1, c);
                unshapeArabicInPlace(one);
                return one.empty() ? c : one[0];
            };
            for (auto& [o, idxs] : byObject) {
                int rtl = 0, ltr = 0;
                bool suspect = false;
                for (int i : idxs) {
                    const unsigned int u = FPDFText_GetUnicode(tp, i);
                    if (isGapSuspect(u)) { suspect = true; continue; }
                    if (u <= 0xFFFF && isRtlChar(static_cast<char16_t>(u))) rtl++;
                    else if ((u >= u'A' && u <= u'Z') || (u >= u'a' && u <= u'z') ||
                             (u >= 0x0370 && u <= 0x058F))
                        ltr++;
                }

                if (!suspect || rtl < 1 || ltr > rtl) continue;
                FPDF_FONT f = FPDFTextObj_GetFont(o);
                const std::vector<uint8_t>* bytes = fontBytesFor(s, f);
                if (!bytes) continue;

                std::set<uint32_t> codes;
                for (const auto& g : readOrigGlyphs(o)) codes.insert(g.code);
                if (!codes.empty()) {
                    std::set<char16_t> named;
                    for (uint32_t c : codes)
                        for (char16_t nc :
                             hbGlyphNameText(bytes->data(), bytes->size(), c))
                            named.insert(baseOf(nc));
                    bool agrees = true;
                    for (int i : idxs) {
                        const unsigned int u = FPDFText_GetUnicode(tp, i);
                        if (isGapSuspect(u) || u > 0xFFFF ||
                            u <= u' ' || u == 0x00A0)
                            continue;
                        if (!named.count(baseOf(static_cast<char16_t>(u)))) {
                            agrees = false;
                            break;
                        }
                    }
                    if (!agrees) continue;
                }
                for (int i : idxs) {
                    const unsigned int u = FPDFText_GetUnicode(tp, i);
                    if (!isGapSuspect(u)) continue;
                    if (!codes.empty() && !codes.count(u)) continue;
                    const std::u16string nm =
                        hbGlyphNameText(bytes->data(), bytes->size(), u);

                    decodeFix[i] = std::u16string(
                        1, (nm.size() == 1 && isRtlChar(nm[0])) ? nm[0]
                                                                : u'\xFFFD');
                }
            }
        }
    }

    {
        std::map<FPDF_FONT, std::map<uint32_t, std::u16string>> lastWins;
        std::set<FPDF_FONT> tried;
        for (int i = 0; i < charCount; i++) {
            if (FPDFText_GetUnicode(tp, i) != 0) continue;
            FPDF_PAGEOBJECT o = FPDFText_GetTextObject(tp, i);
            if (!o) continue;
            FPDF_FONT f = FPDFTextObj_GetFont(o);
            if (!f) continue;
            if (!tried.count(f)) {
                tried.insert(f);
                lastWins[f] = toUnicodeLastWins(s, f);
            }
            const auto& fm = lastWins[f];
            if (fm.empty()) continue;
            double ox = 0, oy = 0;
            if (!FPDFText_GetCharOrigin(tp, i, &ox, &oy)) continue;

            FS_MATRIX m{1, 0, 0, 1, 0, 0};
            FPDFPageObj_GetMatrix(o, &m);
            uint32_t code = 0;
            int hits = 0;
            for (const auto& g : readOrigGlyphs(o)) {
                const float px = m.a * g.x + m.c * g.y + m.e;
                const float py = m.b * g.x + m.d * g.y + m.f;
                if (std::abs(px - static_cast<float>(ox)) < 0.1f &&
                    std::abs(py - static_cast<float>(oy)) < 0.1f) {
                    if (hits++ == 0) code = g.code;
                    else if (g.code != code) hits = 99;
                }
            }
            if (hits != 1) continue;
            auto e = fm.find(code);
            if (e == fm.end()) continue;
            const std::u16string& rep = e->second;
            if (rep.empty() || rep.size() > 4) continue;
            bool clean = true;
            for (char16_t c : rep)
                if (c < u' ' || isUndecodableChar(c)) clean = false;
            if (!clean) continue;
            decodeFix[i] = rep;
        }
    }

    for (int i = 0; i < charCount; i++) {
        FPDF_PAGEOBJECT obj = FPDFText_GetTextObject(tp, i);
        unsigned int uc = FPDFText_GetUnicode(tp, i);

        std::u16string fixExtra;
        {
            auto fx = decodeFix.find(i);
            if (fx != decodeFix.end() && !fx->second.empty()) {
                uc = fx->second[0];
                fixExtra = fx->second.substr(1);
            }
        }

        if (uc == 0x200B) continue;

        if (uc > u' ' && obj && !lyingFonts.empty() &&
            lyingFonts.count(FPDFTextObj_GetFont(obj))) {
            uc = 0xFFFD;
        }

        if (uc == 0x00AD) {
            double hl = 0, hr = 0, hb = 0, ht = 0;
            if (FPDFText_GetCharBox(tp, i, &hl, &hr, &hb, &ht) &&
                (hr - hl) * (ht - hb) < 0.01) {
                uc = u' ';
            }
        }

        if (obj && uc > u' ' && !isUndecodableChar(static_cast<char16_t>(uc)) &&
            !geomFix.count(obj)) {
            auto cIt = containerOf.find(obj);
            if (cIt != containerOf.end() && cIt->second) {
                double cx = 0, cy = 0;
                if (FPDFText_GetCharOrigin(tp, i, &cx, &cy)) {
                    const auto* bd = composedBoundsOf(obj, cIt->second);
                    const float sz =
                        static_cast<float>(FPDFText_GetFontSize(tp, i));
                    const float grow = std::max(8.0f, 2.0f * sz);
                    if (bd && (cx < (*bd)[0] - grow || cx > (*bd)[2] + grow ||
                               cy < (*bd)[1] - grow || cy > (*bd)[3] + grow)) {

                        GeomFix gf;
                        gf.bounds = *bd;
                        FS_MATRIX om{1, 0, 0, 1, 0, 0};
                        FPDFPageObj_GetMatrix(obj, &om);
                        gf.e = om.e;
                        gf.f = om.f;
                        FS_MATRIX fm2;
                        if (FPDFPageObj_GetMatrix(cIt->second, &fm2)) {
                            gf.e = fm2.a * om.e + fm2.c * om.f + fm2.e;
                            gf.f = fm2.b * om.e + fm2.d * om.f + fm2.f;
                        }
                        geomFix[obj] = gf;
                    }
                }
            }
        }
        const GeomFix* gfix = nullptr;
        {
            auto gIt = obj ? geomFix.find(obj) : geomFix.end();
            if (gIt != geomFix.end()) {
                gfix = &gIt->second;

                if (uc > u' ') uc = 0xFFFD;
            }
        }

        if (uc == u' ' && i + 1 < charCount) {
            double sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0;
            bool o0 = FPDFText_GetCharOrigin(tp, i, &sx0, &sy0);
            bool o1 = FPDFText_GetCharOrigin(tp, i + 1, &sx1, &sy1);
            if (o0 && o1 &&
                std::abs(sy1 - sy0) < 0.3 && std::abs(sx1 - sx0) < 0.3) {

                double hole = 0;
                for (int b = i - 1; b >= 0 && b > i - 8; b--) {
                    FS_RECTF pb{0, 0, 0, 0};
                    if (!FPDFText_GetLooseCharBox(tp, b, &pb)) continue;
                    const double pl = std::min(pb.left, pb.right);
                    const double pr = std::max(pb.left, pb.right);
                    if (pr - pl < 0.01) continue;
                    hole = sx1 >= pr ? sx1 - pr : (sx1 <= pl ? pl - sx1 : 0.0);
                    break;
                }

                bool prevIsMark = false;
                if (i >= 2) {
                    FS_RECTF a{0, 0, 0, 0}, b{0, 0, 0, 0};
                    if (FPDFText_GetLooseCharBox(tp, i - 1, &a) &&
                        FPDFText_GetLooseCharBox(tp, i - 2, &b)) {
                        const double al = std::min(a.left, a.right);
                        const double ar = std::max(a.left, a.right);
                        const double bl = std::min(b.left, b.right);
                        const double br = std::max(b.left, b.right);
                        const double ov = std::min(ar, br) - std::max(al, bl);
                        if (ov > 0.5 * std::max(0.01, ar - al)) prevIsMark = true;
                    }
                }

                bool complexNbr = false;
                for (int b = std::max(0, i - 1); b <= std::min(charCount - 1, i + 1); b++) {
                    const unsigned int u3 = FPDFText_GetUnicode(tp, b);
                    if (u3 <= 0xFFFF && cpNeedsComplexShaping(static_cast<char16_t>(u3)))
                        complexNbr = true;
                }
                const double fsz = FPDFText_GetFontSize(tp, i);

                const bool objOwned = obj != nullptr;
                if (complexNbr ||
                    (!objOwned &&
                     (prevIsMark || hole <= 0.08 * (fsz > 0.5 ? fsz : 10.0))))
                    continue;
            }
        }

        auto containerIt = obj ? containerOf.find(obj) : containerOf.end();

        if ((uc == u'\r' || uc == u'\n') && !obj && active &&
            current.lastRealValid && current.rotation == 0) {

            int j = i + 1;
            while (j < charCount) {
                const unsigned int u2 = FPDFText_GetUnicode(tp, j);
                if ((u2 == u'\r' || u2 == u'\n') &&
                    !FPDFText_GetTextObject(tp, j)) {
                    j++;
                    continue;
                }
                break;
            }
            double nx = 0, ny = 0;
            if (j < charCount &&
                FPDFText_GetTextObject(tp, j) == current.object &&
                FPDFText_GetCharOrigin(tp, j, &nx, &ny)) {

                float mx = 0, my = 0;
                state.toModel(static_cast<float>(nx), static_cast<float>(ny), &mx, &my);
                if (std::abs(mx - current.lastRealOx) < 0.35f * current.size &&
                    my < current.lastRealOy - 0.5f * current.size) {
                    continue;
                }
            }
        }
        if (!obj || containerIt == containerOf.end()) {

            flush();
            if (uc == u'\r' || uc == u'\n') {
                pendingSep.clear();
            } else if (!runs.empty() && obj == nullptr) {
                appendUnicode(pendingSep, uc);
            }
            continue;
        }

        float rot = 0;
        FS_MATRIX chm;

        if (!gfix && FPDFText_GetMatrix(tp, i, &chm)) {
            const float det = chm.a * chm.d - chm.b * chm.c;
            const float scale = std::hypot(chm.a, chm.b);
            if (det <= 0 && scale > 0.001f) {
                flush();
                pendingSep.clear();
                continue;
            }
            if (scale > 0.001f) {
                rot = std::atan2(chm.b, chm.a);
                if (std::abs(rot) < 0.005f) rot = 0;
            }
        }
        const float rc = std::cos(rot), rs = std::sin(rot);

        float frameX = 0, frameY = 0;
        state.textFrameOffset(rot, &frameX, &frameY);

        float relRot = rot - static_cast<float>(state.pageRot) *
                                 3.14159265358979f / 180.0f;

        while (relRot <= -3.14159265358979f) relRot += 6.28318530717959f;
        while (relRot > 3.14159265358979f) relRot -= 6.28318530717959f;
        if (std::abs(relRot) < 0.005f) relRot = 0;
        auto derotX = [&](double x, double y) {
            const float x2 = static_cast<float>(x) - state.cropX;
            const float y2 = static_cast<float>(y) - state.cropY;
            return x2 * rc + y2 * rs + frameX;
        };
        auto derotY = [&](double x, double y) {
            const float x2 = static_cast<float>(x) - state.cropX;
            const float y2 = static_cast<float>(y) - state.cropY;
            return -x2 * rs + y2 * rc + frameY;
        };

        if (active && (current.object != obj ||
                       std::abs(current.rotation - relRot) > 0.01f)) {
            flush();
        }

        if (!active) {
            double pox = 0, poy = 0;
            FPDFText_GetCharOrigin(tp, i, &pox, &poy);
            if (gfix) { pox = gfix->e; poy = gfix->f; }
            const float ox = derotX(pox, poy), oy = derotY(pox, poy);
            if (!pendingSep.empty() && !runs.empty()) {

                const ExtractedRun& prev = runs.back();
                float spaceW = nominalAdvance(prev.font, u' ', prev.size);
                if (spaceW <= 0.0f) spaceW = 0.3f * prev.size;
                const float gap = static_cast<float>(ox) - prev.maxX;
                const bool sameLine =
                    std::abs(static_cast<float>(oy) - prev.baseline) <= 0.4f * prev.size;
                if (sameLine && prev.rotation == 0 &&
                    crossesGutter(prev.maxX, static_cast<float>(ox),
                                  prev.baseline)) {

                } else if (sameLine && gap > 2.5f * spaceW) {

                    runs.back().trailingSeparator = std::u16string(1, u'\t');
                } else if (isCjkOrFullwidth(static_cast<char16_t>(uc)) ||
                           (!prev.text.empty() &&
                            isCjkOrFullwidth(prev.text.back()))) {

                } else {
                    runs.back().trailingSeparator = pendingSep;
                }
            }
            pendingSep.clear();
            active = true;
            current.object = obj;
            current.container = containerIt->second;
            current.baseline = static_cast<float>(oy);
            current.startX = static_cast<float>(ox);
            float tf = static_cast<float>(FPDFText_GetFontSize(tp, i));

            float vScale = 1.0f;
            float hScale = 1.0f;
            FS_MATRIX cm;
            if (FPDFText_GetMatrix(tp, i, &cm)) {
                const float hMag = std::hypot(cm.a, cm.b);
                const float vMag = std::hypot(cm.c, cm.d);
                if (vMag > 0.001f) vScale = vMag;
                if (hMag > 0.001f && vMag > 0.001f) {
                    const float hs = hMag / vMag;
                    if (std::abs(hs - 1.0f) > 0.02f) hScale = hs;
                }
            }
            current.size = std::max(1.0f, tf * vScale);
            current.font = FPDFTextObj_GetFont(obj);
            current.style = styleFromObject(obj, current.font, current.size);
            current.style.hScale = hScale;
            current.rotation = relRot;
        }

        if (uc == u'\r' || uc == u'\n') continue;

        const bool wasTab = uc == 0x09;
        if (wasTab) uc = u' ';

        double pox = 0, poy = 0;
        const bool haveOrigin = FPDFText_GetCharOrigin(tp, i, &pox, &poy) != 0;
        if (gfix) { pox = gfix->e; poy = gfix->f; }
        const float ox = derotX(pox, poy);

        const bool ucIsSpace = uc <= 0xFFFF && isWhitespaceChar(static_cast<char16_t>(uc));
        bool healedSpace = false;

        if (haveOrigin && current.prevValid && !current.text.empty()) {
            const float nominal = nominalAdvance(current.font, current.prevCp, current.size);
            const float hs = current.style.hScale > 0.01f ? current.style.hScale : 1.0f;
            float spaceW = nominalAdvance(current.font, u' ', current.size);
            if (spaceW <= 0.0f) spaceW = 0.3f * current.size;
            const float spaceWpage = spaceW * hs;
            if (nominal >= 0 && spaceWpage > 0.01f) {

                const float expectedNext =
                    std::max(current.prevOriginX + nominal * hs,
                             current.hasBounds ? current.maxX : -1e30f);
                const float excess = static_cast<float>(ox) - expectedNext;
                if (excess > 2.5f * spaceWpage &&
                    current.rotation == 0 &&
                    crossesGutter(current.prevOriginX,
                                  static_cast<float>(ox),
                                  current.baseline)) {

                    ExtractedRun fresh;
                    fresh.object = current.object;
                    fresh.container = current.container;
                    fresh.baseline = current.baseline;
                    fresh.startX = static_cast<float>(ox);
                    fresh.size = current.size;
                    fresh.font = current.font;
                    fresh.style = current.style;
                    fresh.rotation = current.rotation;
                    flush();
                    current = std::move(fresh);
                    active = true;
                    healedSpace = true;
                } else if (excess > 2.5f * spaceWpage) {

                    const bool cplx =
                        cpNeedsComplexShaping(uc) ||
                        (!current.text.empty() &&
                         cpNeedsComplexShaping(current.text.back()));
                    if (!cplx) {
                        current.text.push_back(u'\t');
                        current.adv.resize(current.text.size(), -1.0f);
                        current.cx.resize(current.text.size(), kNoOx);
                        current.adv.back() = excess;
                    }
                    current.lastRealValid = false;
                    healedSpace = true;
                }
            }
        }

        const bool complexNeighbors =
            cpNeedsComplexShaping(uc) ||
            (!current.text.empty() &&
             cpNeedsComplexShaping(current.text.back()));

        const bool cjkNeighbor =
            isCjkOrFullwidth(static_cast<char16_t>(uc)) ||
            (!current.text.empty() && isCjkOrFullwidth(current.text.back()));
        if (!healedSpace && !complexNeighbors && !cjkNeighbor &&
            !current.text.empty() && !ucIsSpace &&
            !isWhitespaceChar(current.text.back())) {
            if (haveOrigin && current.hasBounds) {
                float gap = static_cast<float>(ox) - current.maxX;
                if (gap > 0.24f * current.size && gap < 2.5f * current.size) {
                    current.text.push_back(u' ');

                    float sAdv = -1.0f;
                    if (current.lastRealValid &&
                        current.lastRealUnit < current.adv.size()) {
                        const float hs2 = current.style.hScale > 0.01f
                                              ? current.style.hScale
                                              : 1.0f;
                        const float nom = nominalAdvance(
                            current.font, current.prevCp, current.size);
                        if (nom >= 0) {
                            const float total =
                                static_cast<float>(ox) - current.lastRealOx;
                            const float prevAdv = nom * hs2;
                            if (total > prevAdv + 0.05f &&
                                total < prevAdv + 2.5f * current.size) {
                                current.adv[current.lastRealUnit] = prevAdv;
                                sAdv = total - prevAdv;
                            }
                        }
                    }
                    current.adv.push_back(sAdv);
                    current.cx.push_back(kNoOx);
                    current.lastRealValid = false;
                    healedSpace = true;
                }
            }
        }

        if (haveOrigin && !healedSpace && !ucIsSpace && current.prevValid &&
            !current.text.empty() && !isWhitespaceChar(current.text.back())) {
            const float nominal = nominalAdvance(current.font, current.prevCp, current.size);
            const float hs = current.style.hScale > 0.01f ? current.style.hScale : 1.0f;
            if (nominal >= 0) {
                const float extra =
                    (static_cast<float>(ox) - current.prevOriginX) / hs - nominal;
                if (extra > -0.4f * current.size && extra < 0.9f * current.size) {
                    current.tcSamples.push_back(extra);
                }
            }
        }

        if (haveOrigin && current.prevValid && current.prevCp <= 0xFFFF &&
            uc <= 0xFFFF && isRtlChar(static_cast<char16_t>(current.prevCp)) &&
            isRtlChar(static_cast<char16_t>(uc)) &&
            static_cast<float>(ox) - current.prevOriginX > 0.05f) {
            current.rtlAsc++;
        }

        if (haveOrigin) {
            current.prevOriginX = static_cast<float>(ox);
            current.prevCp = uc;
            current.prevValid = true;
        } else {
            current.prevValid = false;
        }

        const float oyDerot = derotY(pox, poy);
        if (haveOrigin && current.lastRealValid &&
            current.lastRealUnit < current.adv.size()) {
            const float d = ox - current.lastRealOx;

            const bool prevWasSpace =
                current.lastRealUnit < current.text.size() &&
                isWhitespaceChar(current.text[current.lastRealUnit]);
            if ((d > 0.0f || (prevWasSpace && d >= 0.0f)) &&
                d < 6.0f * current.size) {

                size_t cs = current.lastRealUnit;
                const float clusterOx =
                    current.lastRealUnit < current.cx.size()
                        ? current.cx[current.lastRealUnit] : kNoOx;
                bool ligature =
                    clusterOx != kNoOx &&
                    current.lastRealUnit < current.text.size() &&
                    !cpNeedsComplexShaping(current.text[current.lastRealUnit]) &&
                    !isCombiningMark(current.text[current.lastRealUnit]);
                while (ligature && cs > 0 && cs - 1 < current.cx.size() &&
                       cs - 1 < current.text.size() &&
                       current.cx[cs - 1] != kNoOx &&
                       std::abs(current.cx[cs - 1] - clusterOx) < 0.1f) {
                    const char16_t pc = current.text[cs - 1];
                    if (isWhitespaceChar(pc)) break;
                    if (cpNeedsComplexShaping(pc) || isCombiningMark(pc)) {
                        ligature = false;
                        break;
                    }
                    cs--;
                }
                if (ligature && current.lastRealUnit > cs)
                    current.adv[current.lastRealUnit] = -1.0f;
                else
                    current.adv[current.lastRealUnit] = d;
            }

            current.pairCount++;
            if (oyDerot < current.lastRealOy - 0.5f * current.size &&
                std::abs(d) < 0.35f * current.size) {
                current.vertVotes++;
            }
        }
        const size_t unitIdx = current.text.size();
        appendUnicode(current.text, uc);

        if (current.font && !wasTab) {
            s.fontRenderedCps[current.font].insert(uc);
            registerDocFont(s, current.font, current.style);
        }
        current.adv.resize(current.text.size(), -1.0f);
        current.cx.resize(current.text.size(),
                          haveOrigin ? static_cast<float>(ox) : kNoOx);
        if (current.text.size() >= unitIdx + 2) {
            current.adv[unitIdx + 1] = 0.0f;
        }
        if (haveOrigin) {
            current.lastRealUnit = unitIdx;
            current.lastRealOx = ox;
            current.lastRealOy = oyDerot;
            current.lastRealValid = true;
        } else {
            current.lastRealValid = false;
        }

        if (!fixExtra.empty()) {
            for (char16_t ec2 : fixExtra) {
                appendUnicode(current.text, ec2);
                if (current.font && !wasTab)
                    s.fontRenderedCps[current.font].insert(ec2);
            }
            current.adv.resize(current.text.size(), -1.0f);
            current.cx.resize(current.text.size(),
                              haveOrigin ? static_cast<float>(ox) : kNoOx);
            current.lastRealValid = false;
        }
        if (ucIsSpace) {
            current.wordOpen = false;
        } else if (!current.wordOpen) {
            current.wordOpen = true;
            current.wordStartOx.push_back(haveOrigin ? static_cast<float>(ox)
                                                     : -1.0f);
        }

        auto addRotatedBox = [&](float l, float b, float r, float t) {
            const float xs[4] = {derotX(l, b), derotX(r, b), derotX(l, t), derotX(r, t)};
            const float ys[4] = {derotY(l, b), derotY(r, b), derotY(l, t), derotY(r, t)};
            current.addBox(std::min({xs[0], xs[1], xs[2], xs[3]}),
                           std::min({ys[0], ys[1], ys[2], ys[3]}),
                           std::max({xs[0], xs[1], xs[2], xs[3]}),
                           std::max({ys[0], ys[1], ys[2], ys[3]}));
        };
        FS_RECTF lb;
        if (gfix) {

            addRotatedBox(gfix->bounds[0], gfix->bounds[1],
                          gfix->bounds[2], gfix->bounds[3]);
        } else if (FPDFText_GetLooseCharBox(tp, i, &lb)) {
            addRotatedBox(std::min(lb.left, lb.right), std::min(lb.bottom, lb.top),
                          std::max(lb.left, lb.right), std::max(lb.bottom, lb.top));
        } else {
            double l, r, b, t;
            if (FPDFText_GetCharBox(tp, i, &l, &r, &b, &t)) {

                addRotatedBox(static_cast<float>(l), static_cast<float>(b),
                              static_cast<float>(r), static_cast<float>(t));
            }
        }
    }
    flush();
    FPDFText_ClosePage(tp);
    if (runs.empty()) return state;

    struct Ruling {
        FPDF_PAGEOBJECT source;
        bool vertical;
        float pos;
        float lo, hi;
    };
    std::vector<Ruling> rulings;
    {
        auto addSeg = [&](FPDF_PAGEOBJECT src, float x0, float y0, float x1, float y1) {
            const float dx = std::abs(x1 - x0), dy = std::abs(y1 - y0);
            if (dx <= 1.2f && dy >= 5.0f) {
                rulings.push_back({src, true, (x0 + x1) / 2, std::min(y0, y1), std::max(y0, y1)});
            } else if (dy <= 1.2f && dx >= 5.0f) {
                rulings.push_back({src, false, (y0 + y1) / 2, std::min(x0, x1), std::max(x0, x1)});
            }
        };
        for (FPDF_PAGEOBJECT path : pagePaths) {
            float l = 0, b = 0, r = 0, t = 0;
            if (!FPDFPageObj_GetBounds(path, &l, &b, &r, &t)) continue;
            mapRect(l, b, r, t, &l, &b, &r, &t);
            const float w = r - l, h = t - b;
            if (w <= 2.5f && h >= 5.0f) {
                rulings.push_back({path, true, (l + r) / 2, b, t});
            } else if (h <= 2.5f && w >= 5.0f) {
                rulings.push_back({path, false, (b + t) / 2, l, r});
            } else if (w > 2.5f && h > 2.5f) {
                const int nseg = FPDFPath_CountSegments(path);
                if (nseg <= 0 || nseg > 4096) continue;
                FS_MATRIX m{1, 0, 0, 1, 0, 0};
                FPDFPageObj_GetMatrix(path, &m);
                float cx = 0, cy = 0, sx = 0, sy = 0;
                bool have = false;
                for (int si = 0; si < nseg; si++) {
                    FPDF_PATHSEGMENT sg = FPDFPath_GetPathSegment(path, si);
                    if (!sg) continue;
                    float px = 0, py = 0;
                    if (!FPDFPathSegment_GetPoint(sg, &px, &py)) continue;
                    const float gx = mapX(m.a * px + m.c * py + m.e,
                                         m.b * px + m.d * py + m.f);
                    const float gy = mapY(m.a * px + m.c * py + m.e,
                                         m.b * px + m.d * py + m.f);
                    const int type = FPDFPathSegment_GetType(sg);
                    if (type == FPDF_SEGMENT_MOVETO) {
                        sx = gx; sy = gy;
                    } else if (type == FPDF_SEGMENT_LINETO && have) {
                        addSeg(path, cx, cy, gx, gy);
                    }
                    if (FPDFPathSegment_GetClose(sg) && have) addSeg(path, gx, gy, sx, sy);
                    cx = gx; cy = gy; have = true;
                }
            }
        }
    }

    if (getenv("EC_DEBUG_RULINGS")) {
        int v = 0, h = 0;
        for (const Ruling& rl : rulings) (rl.vertical ? v : h)++;
        fprintf(stderr, "[rulings] pre-join: %d vertical, %d horizontal\n", v, h);
        for (const Ruling& rl : rulings)
            fprintf(stderr, "  %c pos %.1f  [%.1f..%.1f]\n",
                    rl.vertical ? 'V' : 'H', rl.pos, rl.lo, rl.hi);
    }

    {
        std::sort(rulings.begin(), rulings.end(), [](const Ruling& a, const Ruling& b) {
            if (a.vertical != b.vertical) return a.vertical < b.vertical;
            if (std::abs(a.pos - b.pos) > 0.001f) return a.pos < b.pos;
            return a.lo < b.lo;
        });
        std::vector<Ruling> joined;
        for (const Ruling& r : rulings) {
            if (!joined.empty()) {
                Ruling& j = joined.back();
                const bool sameLine = j.vertical == r.vertical &&
                                      std::abs(j.pos - r.pos) <= 1.5f;
                if (sameLine && r.lo - j.hi <= 36.0f) {
                    j.hi = std::max(j.hi, r.hi);
                    j.lo = std::min(j.lo, r.lo);
                    continue;
                }
            }
            joined.push_back(r);
        }

        for (const Ruling& j : joined) rulings.push_back(j);
    }

    auto verticalRulingBetween = [&](float xLo, float xHi, float yLo, float yHi) {
        if (xHi - xLo <= 0.4f) return false;
        for (const Ruling& rl : rulings) {
            if (!rl.vertical) continue;
            if (rl.pos <= xLo + 0.3f || rl.pos >= xHi - 0.3f) continue;
            if (rl.lo <= yLo + 1.5f && rl.hi >= yHi - 1.5f) return true;
        }
        return false;
    };

    for (size_t i = 0; i < runs.size();) {
        if (runs[i].vertical || runs[i].text.size() > 2 ||
            runs[i].rotation != 0) {
            i++;
            continue;
        }
        std::vector<size_t> chain{i};
        size_t j = i;
        while (j + 1 < runs.size()) {
            const ExtractedRun& a = runs[chain.back()];
            const ExtractedRun& b = runs[j + 1];
            if (b.text.size() <= 2 && b.rotation == 0 &&
                std::abs(b.startX - a.startX) < 0.35f * a.size &&
                b.baseline < a.baseline - 0.4f * a.size &&
                b.baseline > a.baseline - 2.2f * a.size) {
                chain.push_back(j + 1);
                j++;
            } else {
                break;
            }
        }
        bool lonely = chain.size() >= 4;
        if (lonely) {
            for (size_t k : chain) {
                for (size_t q = 0; q < runs.size() && lonely; q++) {
                    if (q == k) continue;
                    if (std::abs(runs[q].baseline - runs[k].baseline) <
                            0.4f * runs[k].size &&
                        std::abs(runs[q].startX - runs[k].startX) <
                            6.0f * runs[k].size &&
                        std::find(chain.begin(), chain.end(), q) == chain.end())
                        lonely = false;
                }
            }
        }
        if (lonely)
            for (size_t k : chain) runs[k].vertical = true;
        i = j + 1;
    }

    {
        std::vector<ExtractedRun> vert;
        std::vector<ExtractedRun> horiz;
        for (auto& r : runs)
            (r.vertical ? vert : horiz).push_back(std::move(r));
        runs = std::move(horiz);
        if (!vert.empty()) {

            std::sort(vert.begin(), vert.end(),
                      [](const ExtractedRun& a, const ExtractedRun& b) {
                          return a.startX > b.startX;
                      });
            Paragraph* cur = nullptr;
            float lastX = 0;
            for (auto& r : vert) {
                const bool adjacent =
                    cur && std::abs(lastX - r.startX) < 3.0f * r.size;

                const bool sameColumn =
                    cur && !cur->runs.empty() &&
                    std::abs(lastX - r.startX) < 0.35f * r.size;
                if (sameColumn) {
                    ParaRun& back = cur->runs.back();
                    back.text.insert(back.text.size() - 1, r.text);
                    cur->objects.push_back({r.object, r.container, false});
                    cur->x = std::min(cur->x, r.minX);
                    cur->top = std::max(cur->top, r.maxY);
                    cur->width = std::max(cur->width, r.maxX - cur->x);
                    cur->height = std::max(cur->height, cur->top - r.minY);
                    if (!cur->lines.empty()) {
                        cur->lines.back().w = std::max(
                            cur->lines.back().w, r.maxX - cur->lines.back().x);
                    }
                    lastX = r.startX;
                    continue;
                }
                if (!adjacent) {
                    state.paras.emplace_back();
                    cur = &state.paras.back();
                    cur->id = s.nextParaId++;
                    cur->vertical = true;
                    cur->editable = true;
                    cur->x = r.minX;
                    cur->top = r.maxY;
                    cur->width = std::max(1.0f, r.maxX - r.minX);
                    cur->height = std::max(1.0f, r.maxY - r.minY);
                } else {
                    cur->x = std::min(cur->x, r.minX);
                    cur->top = std::max(cur->top, r.maxY);
                    cur->width = std::max(cur->width, r.maxX - cur->x);
                    cur->height =
                        std::max(cur->height, cur->top - r.minY);
                }
                lastX = r.startX;
                ParaRun pr;
                pr.text = r.text + u"\n";
                pr.style = r.style;
                pr.originalFont = r.font;
                pr.textUnchanged = true;
                cur->runs.push_back(std::move(pr));

                cur->objects.push_back({r.object, r.container, false});
                cur->lines.push_back(
                    {r.baseline, r.minX, std::max(1.0f, r.maxX - r.minX)});
            }
        }
    }

    std::sort(runs.begin(), runs.end(), [](const ExtractedRun& a, const ExtractedRun& b) {
        if (std::abs(a.baseline - b.baseline) > 0.5f) return a.baseline > b.baseline;
        return a.startX < b.startX;
    });

    std::vector<ExtractedLine> lines;
    for (auto& run : runs) {
        bool joined = false;
        if (!lines.empty()) {
            ExtractedLine& last = lines.back();
            float tol = std::max(1.5f, run.size * 0.4f);
            float gap = 0;
            if (last.maxX < run.minX) gap = run.minX - last.maxX;
            else if (run.maxX < last.minX) gap = last.minX - run.maxX;

            const float overlapX =
                std::min(last.maxX, run.maxX) - std::max(last.minX, run.minX);
            const float narrowW = std::max(
                1.0f, std::min(last.maxX - last.minX, run.maxX - run.minX));
            const bool layered = overlapX > 0.45f * narrowW;
            bool cellBorder = false;
            if (run.rotation == 0 && gap > 0) {
                const float bx0 = last.maxX < run.minX ? last.maxX : run.maxX;
                const float bx1 = last.maxX < run.minX ? run.minX : last.minX;
                float byLo = std::max(last.minY, run.minY);
                float byHi = std::min(last.maxY, run.maxY);
                if (byHi <= byLo) {
                    byLo = run.baseline - 0.6f * run.size;
                    byHi = run.baseline + 0.2f * run.size;
                }
                cellBorder = verticalRulingBetween(bx0, bx1, byLo, byHi);
            }

            const bool columnBreak =
                run.rotation == 0 && gap > 0 &&
                crossesGutter(last.maxX < run.minX ? last.maxX : run.maxX,
                              last.maxX < run.minX ? run.minX : last.minX,
                              run.baseline);

            const bool sizeGulf =
                std::min(run.size, last.dominantSize) <
                    0.55f * std::max(run.size, last.dominantSize) &&
                gap > 0.75f * std::min(run.size, last.dominantSize);

            const bool crossLayer =
                (run.style.renderMode == 3) != last.invisible();
            if (!cellBorder && !layered && !columnBreak && !sizeGulf &&
                !crossLayer &&
                std::abs(last.rotation - run.rotation) <= 0.01f &&
                std::abs(last.baseline - run.baseline) <= tol &&
                gap <= std::max(run.size, last.dominantSize) * 2.2f) {
                last.runs.push_back(run);
                last.recompute();
                joined = true;
            }
        }
        if (!joined) {
            ExtractedLine line;
            line.runs.push_back(run);
            line.baseline = run.baseline;
            line.recompute();
            lines.push_back(line);
        }
    }

    for (bool merged = true; merged;) {
        merged = false;
        for (size_t i = 0; i + 1 < lines.size() && !merged; i++) {
            for (size_t j = i + 1; j < lines.size() && !merged; j++) {
                ExtractedLine& a = lines[i];
                ExtractedLine& b = lines[j];
                const float tol =
                    std::max(1.5f, std::max(a.dominantSize, b.dominantSize) * 0.4f);
                if (std::abs(a.rotation - b.rotation) > 0.01f) continue;
                if (a.invisible() != b.invisible()) continue;
                if (std::abs(a.baseline - b.baseline) > tol) continue;
                float gap = 0;
                if (a.maxX < b.minX) gap = b.minX - a.maxX;
                else if (b.maxX < a.minX) gap = a.minX - b.maxX;
                if (gap > std::max(a.dominantSize, b.dominantSize) * 2.2f) continue;

                if (std::min(a.dominantSize, b.dominantSize) <
                        0.55f * std::max(a.dominantSize, b.dominantSize) &&
                    gap > 0.75f * std::min(a.dominantSize, b.dominantSize))
                    continue;
                if (a.rotation == 0 && gap > 0 &&
                    crossesGutter(a.maxX < b.minX ? a.maxX : b.maxX,
                                  a.maxX < b.minX ? b.minX : a.minX,
                                  a.baseline))
                    continue;

                {
                    const float ovX = std::min(a.maxX, b.maxX) - std::max(a.minX, b.minX);
                    const float nw =
                        std::max(1.0f, std::min(a.maxX - a.minX, b.maxX - b.minX));
                    if (ovX > 0.45f * nw) continue;
                }
                if (a.rotation == 0 && gap > 0 &&
                    verticalRulingBetween(std::min(a.maxX, b.maxX), std::max(a.minX, b.minX),
                                          std::max(a.minY, b.minY), std::min(a.maxY, b.maxY)))
                    continue;
                a.runs.insert(a.runs.end(), b.runs.begin(), b.runs.end());
                a.recompute();
                lines.erase(lines.begin() + static_cast<long>(j));
                merged = true;
            }
        }
    }
    for (auto& line : lines) {
        line.recompute();
        std::sort(line.runs.begin(), line.runs.end(),
                  [](const ExtractedRun& a, const ExtractedRun& b) { return a.startX < b.startX; });
    }

    struct DecorationCandidate {
        FPDF_PAGEOBJECT obj;
        float x0, x1, yMid, h;

        bool ours = false;
        bool consumed = false;
    };
    auto hasDecoMark = [](FPDF_PAGEOBJECT obj) {
        const int n = FPDFPageObj_CountMarks(obj);
        for (int i = 0; i < n; i++) {
            FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(obj, i);
            if (!mk) continue;
            unsigned short nb[16] = {0};
            unsigned long got = 0;
            if (!FPDFPageObjMark_GetName(mk, nb, sizeof(nb), &got)) continue;
            static const char16_t kName[] = u"EC_Deco";
            bool eq = true;
            for (size_t k = 0; k < 8; k++)
                if (nb[k] != static_cast<unsigned short>(kName[k])) { eq = false; break; }
            if (eq) return true;
        }
        return false;
    };
    std::vector<DecorationCandidate> decorations;
    for (FPDF_PAGEOBJECT path : pagePaths) {
        float l = 0, b = 0, r = 0, t = 0;
        if (!FPDFPageObj_GetBounds(path, &l, &b, &r, &t)) continue;
        mapRect(l, b, r, t, &l, &b, &r, &t);
        const float h = t - b;
        const float w = r - l;
        if (h <= 0 || h > 2.8f || w < 2.0f || w / h < 4.0f) continue;
        decorations.push_back({path, l, r, (b + t) / 2, h, hasDecoMark(path)});
    }
    for (size_t li = 0; li < lines.size(); li++) {
        for (auto& run : lines[li].runs) {

            if (run.rotation != 0) continue;
            const float size = std::max(1.0f, run.size);
            const float runWidth = std::max(1.0f, run.maxX - run.minX);
            for (auto& d : decorations) {
                if (d.consumed) continue;
                const float overlap = std::min(run.maxX, d.x1) - std::max(run.minX, d.x0);
                if (overlap < 0.5f * std::min(runWidth, d.x1 - d.x0)) continue;

                const float tailTol = d.ours ? std::max(6.0f, size) : 3.0f;
                if (d.x0 < run.minX - 3.0f || d.x1 > run.maxX + tailTol) continue;

                bool isBorder = false;
                if (!d.ours) {
                    for (const Ruling& rl : rulings) {
                        if (rl.vertical || std::abs(rl.pos - d.yMid) > 1.0f) continue;
                        if (rl.lo > d.x0 + 1.0f || rl.hi < d.x1 - 1.0f) continue;
                        if (rl.lo < run.minX - std::max(6.0f, size) ||
                            rl.hi > run.maxX + std::max(6.0f, size)) {
                            isBorder = true;
                            break;
                        }
                    }
                }
                if (isBorder) continue;
                const float rel = d.yMid - run.baseline;
                bool matched = false;
                if (rel >= -0.34f * size && rel <= -0.01f * size) {
                    run.style.underline = true;
                    matched = true;
                } else if (rel >= 0.14f * size && rel <= 0.48f * size) {
                    run.style.strike = true;
                    matched = true;
                }
                if (matched) {
                    d.consumed = true;
                    lines[li].decorations.push_back(d.obj);
                }
            }
        }
    }

    std::set<FPDF_PAGEOBJECT> consumedDecorations;
    for (const auto& d : decorations) {
        if (d.consumed) consumedDecorations.insert(d.obj);
    }
    auto horizontalRulingBetween = [&](const ExtractedLine& above, const ExtractedLine& below) {
        const float xLo = std::max(above.minX, below.minX);
        const float xHi = std::min(above.maxX, below.maxX);
        if (xHi - xLo < 2.0f) return false;

        const float hiStrict = above.baseline - 0.36f * above.dominantSize;
        const float hiLoose = above.baseline - 0.03f * above.dominantSize;
        const float lo = below.baseline + 0.75f * below.dominantSize;
        if (hiLoose <= lo) return false;
        const float margin = std::max(6.0f, above.dominantSize);
        for (const Ruling& rl : rulings) {
            if (rl.vertical) continue;
            if (consumedDecorations.count(rl.source)) continue;
            if (rl.pos <= lo || rl.pos >= hiLoose) continue;
            if (rl.pos >= hiStrict &&
                rl.lo >= above.minX - margin && rl.hi <= above.maxX + margin)
                continue;
            if (rl.lo <= xLo + 2.0f && rl.hi >= xHi - 2.0f) return true;
        }
        return false;
    };

    auto isMarkerRun = [](const ExtractedRun& r) {
        int undecodable = 0, printable = 0;
        for (char16_t c : r.text) {
            if (isWhitespaceChar(c)) continue;
            if (isUndecodableChar(c)) undecodable++;
            else printable++;
        }
        return undecodable > 0 && printable == 0 && undecodable <= 4;
    };

    struct ParaAccum {
        std::vector<ExtractedLine> lines;
        float minX, maxX, minY, maxY;
        std::vector<float> gaps;
    };

    auto startsWithTextMarker = [](const ExtractedLine& line) {
        if (line.runs.empty()) return false;
        const std::u16string& t = line.runs.front().text;
        size_t i = 0;
        while (i < t.size() && t[i] == u' ') i++;
        if (i >= t.size()) return false;
        const char16_t c = t[i];
        const bool bullet = c == 0x2022 || c == 0x25E6 || c == 0x25AA ||
                            c == 0x2023 || c == 0x00B7 || c == 0x2219 ||
                            c == u'-' || c == 0x2013;
        if (bullet) return i + 1 < t.size() && isWhitespaceChar(t[i + 1]);
        size_t j = i;
        while (j < t.size() && t[j] >= u'0' && t[j] <= u'9' && j - i < 2) j++;
        if (j == i && c >= u'a' && c <= u'z') j = i + 1;
        if (j == i || j >= t.size()) return false;

        size_t k = j;
        while (k + 1 < t.size() && t[k] == u'.' && t[k + 1] >= u'0' &&
               t[k + 1] <= u'9') {
            k++;
            size_t d = 0;
            while (k < t.size() && t[k] >= u'0' && t[k] <= u'9' && d < 2) {
                k++;
                d++;
            }
        }
        if (k > j) {
            if (k < t.size() && (t[k] == u'.' || t[k] == u')')) k++;
            return k < t.size() && isWhitespaceChar(t[k]) && k - i <= 9;
        }
        if (t[j] != u'.' && t[j] != u')') return false;
        return j + 1 < t.size() && isWhitespaceChar(t[j + 1]);
    };

    auto endsAsTocRow = [](const ExtractedLine& line) {
        std::u16string t;
        for (const auto& r : line.runs) t += r.text;

        size_t run = 0, dotEnd = std::u16string::npos;
        for (size_t i = 0; i < t.size(); i++) {
            if (t[i] == u'.') { if (++run >= 4) dotEnd = i; }
            else if (run >= 4) break;
            else run = 0;
        }
        if (dotEnd == std::u16string::npos) return false;

        size_t k = dotEnd + 1;
        while (k < t.size() && (t[k] == u' ' || t[k] == u'.')) k++;
        std::u16string tail = t.substr(k);
        while (!tail.empty() && (tail.back() == u' ' || tail.back() == u'\t' ||
                                 tail.back() == u'\n' || tail.back() == u'\r'))
            tail.pop_back();
        if (tail.empty() || tail.size() > 18 ||
            tail.find(u' ') != std::u16string::npos)
            return false;
        bool sawDigit = false;
        for (char16_t c : tail)
            if (c >= u'0' && c <= u'9') { sawDigit = true; break; }
        if (sawDigit) {

            for (char16_t c : tail) {
                const bool ok = (c >= u'0' && c <= u'9') ||
                                (c >= u'a' && c <= u'z') ||
                                (c >= u'A' && c <= u'Z') || c == u'-' || c == u'.';
                if (!ok) return false;
            }
            return true;
        }

        for (char16_t c : tail) {
            const char16_t l = (c >= u'A' && c <= u'Z') ? c + 32 : c;
            if (l != u'i' && l != u'v' && l != u'x' && l != u'l' && l != u'c' &&
                l != u'd' && l != u'm')
                return false;
        }
        return true;
    };
    std::vector<ParaAccum> accums;
    for (auto& line : lines) {

        const bool markerLed = !line.runs.empty() &&
            (isMarkerRun(line.runs.front()) || startsWithTextMarker(line));

        auto isLeaderRule = [](const ExtractedLine& ln2) {
            int dots = 0, vis = 0;
            for (const auto& r2 : ln2.runs)
                for (char16_t c2 : r2.text) {
                    if (c2 == u' ' || c2 == u'\t') continue;
                    vis++;
                    if (c2 == u'.' || c2 == 0x2026) dots++;
                }
            return dots >= 8 && dots * 2 >= vis;
        };
        const bool lineIsRule = isLeaderRule(line);

        auto isAllUndecodable = [&](const ExtractedLine& ln2) {
            int vis = 0, undec = 0;
            for (const auto& r2 : ln2.runs) {
                const bool junk2 = fontIsJunk(r2.font);
                for (char16_t c2 : r2.text) {
                    if (isWhitespaceChar(c2) || c2 == u'\n') continue;
                    vis++;
                    if (junk2 || isUndecodableChar(c2)) undec++;
                }
            }
            return vis > 0 && undec == vis;
        };
        const bool lineIsInk = isAllUndecodable(line);
        bool joined = false;
        for (size_t back = accums.size(); back > 0 && !joined && !markerLed; back--) {
            ParaAccum& acc = accums[back - 1];
            const ExtractedLine& prev = acc.lines.back();
            float gap = prev.baseline - line.baseline;
            float sizeRef = std::max(prev.dominantSize, line.dominantSize);

            if (gap > 3.0f * sizeRef) break;
            float overlap =
                std::min(acc.maxX, line.maxX) - std::max(acc.minX, line.minX);
            float narrower = std::min(acc.maxX - acc.minX, line.maxX - line.minX);

            if (lineIsRule || isLeaderRule(prev)) continue;
            if (lineIsInk || isAllUndecodable(prev)) continue;

            if (line.invisible() != prev.invisible()) continue;
            bool sizeCompatible = line.dominantSize > prev.dominantSize * 0.86f &&
                                  line.dominantSize < prev.dominantSize * 1.16f;

            if (sizeCompatible && !acc.lines.empty()) {
                const float ref = acc.lines.front().dominantSize;
                if (ref > 0.5f &&
                    (line.dominantSize < ref * 0.82f ||
                     line.dominantSize > ref * 1.22f))
                    sizeCompatible = false;
            }

            bool alignCompatible = true;
            const float sizeRatio =
                line.dominantSize / std::max(1.0f, prev.dominantSize);
            if (sizeRatio < 0.95f || sizeRatio > 1.05f) {
                const float uMinX = std::min(acc.minX, line.minX);
                const float uMaxX = std::max(acc.maxX, line.maxX);
                const float tolEdge = std::max(2.0f, 0.35f * sizeRef);
                auto symmetricInset = [&](const ExtractedLine& ln) {
                    const float li = ln.minX - uMinX, ri = uMaxX - ln.maxX;
                    return li > 2.5f * ln.dominantSize &&
                           ri > 2.5f * ln.dominantSize &&
                           std::abs(li - ri) <=
                               std::max(2.0f * tolEdge, 0.3f * std::max(li, ri));
                };
                if (symmetricInset(prev) != symmetricInset(line))
                    alignCompatible = false;
            }

            float threshold;
            if (acc.gaps.empty()) {
                threshold = 2.05f * sizeRef;
            } else {
                std::vector<float> sortedGaps = acc.gaps;
                std::sort(sortedGaps.begin(), sortedGaps.end());
                threshold = sortedGaps[sortedGaps.size() / 2] * 1.35f;
            }
            const float prevSpan = std::max(1.0f, prev.maxY - prev.minY);
            const float lineSpan = std::max(1.0f, line.maxY - line.minY);

            bool spanGapOk = true;
            if (acc.gaps.empty()) {
                float nextGap = -1.0f;
                const size_t lineIdx =
                    static_cast<size_t>(&line - lines.data());
                if (lineIdx + 1 < lines.size()) {
                    const ExtractedLine& nxt = lines[lineIdx + 1];
                    const float aheadGap = line.baseline - nxt.baseline;
                    const float aheadOverlap = std::min(line.maxX, nxt.maxX) -
                                               std::max(line.minX, nxt.minX);
                    const float aheadNarrower =
                        std::min(line.maxX - line.minX, nxt.maxX - nxt.minX);
                    if (aheadGap > 0.3f * sizeRef &&
                        (aheadNarrower <= 0 ||
                         aheadOverlap >= 0.35f * aheadNarrower))
                        nextGap = aheadGap;
                }
                spanGapOk = nextGap > 0.0f
                                ? gap <= nextGap * 1.35f
                                : gap <= 0.65f * (prevSpan + lineSpan);
            }

            bool overlapsSettled = false;
            {
                const float ux0 = std::min(acc.minX, line.minX);
                const float ux1 = std::max(acc.maxX, line.maxX);
                const float uy0 = std::min(acc.minY, line.minY);
                const float uy1 = std::max(acc.maxY, line.maxY);
                for (const ParaAccum& done : accums) {
                    if (&done == &acc) continue;
                    if (done.lines.empty()) continue;
                    const float cx = 0.5f * (done.minX + done.maxX);
                    const float cy = 0.5f * (done.minY + done.maxY);
                    if (cx >= ux0 && cx <= ux1 && cy >= uy0 && cy <= uy1) {
                        overlapsSettled = true;
                        break;
                    }
                }
            }

            if (std::abs(prev.rotation - line.rotation) <= 0.01f &&
                gap > 0.3f * sizeRef && gap <= threshold && spanGapOk &&
                !overlapsSettled && sizeCompatible &&
                alignCompatible && !endsAsTocRow(prev) &&
                !(line.rotation == 0 && horizontalRulingBetween(prev, line)) &&
                (narrower <= 0 || overlap >= 0.35f * narrower)) {
                acc.lines.push_back(line);
                acc.gaps.push_back(gap);
                acc.minX = std::min(acc.minX, line.minX);
                acc.maxX = std::max(acc.maxX, line.maxX);
                acc.minY = std::min(acc.minY, line.minY);
                acc.maxY = std::max(acc.maxY, line.maxY);
                joined = true;
            }
        }
        if (!joined) {
            accums.push_back({{line}, line.minX, line.maxX, line.minY, line.maxY, {}});
        }
    }

    {
        std::vector<ParaAccum> resplit;
        resplit.reserve(accums.size());
        for (auto& acc : accums) {
            const size_t n = acc.lines.size();
            bool didSplit = false;

            if (n >= 8) {
                float sizeRef = 0;
                for (const auto& l : acc.lines)
                    sizeRef = std::max(sizeRef, l.dominantSize);
                if (sizeRef < 0.5f) sizeRef = 10.0f;

                const float bucket = 2.0f;
                std::map<int, int> hist;
                float minLeft = acc.lines.front().minX;
                for (const auto& l : acc.lines) {
                    hist[static_cast<int>(l.minX / bucket)]++;
                    minLeft = std::min(minLeft, l.minX);
                }
                int bestKey = 0, bestCnt = -1;
                for (const auto& kv : hist)
                    if (kv.second > bestCnt) { bestCnt = kv.second; bestKey = kv.first; }
                const float bodyLeft = (bestKey + 0.5f) * bucket;
                const float indentMin = std::max(4.0f, 0.30f * sizeRef);
                const float indentMax = 48.0f;

                const bool flushBody =
                    bodyLeft <= minLeft + bucket + 0.5f &&
                    bestCnt * 2 >= static_cast<int>(n);
                if (flushBody) {
                    std::vector<size_t> starts;
                    for (size_t i = 1; i < n; i++) {
                        const float ind = acc.lines[i].minX - bodyLeft;

                        const bool prevOnBody =
                            acc.lines[i - 1].minX <= bodyLeft + indentMin;
                        if (ind >= indentMin && ind <= indentMax && prevOnBody)
                            starts.push_back(i);
                    }
                    if (!starts.empty()) {
                        size_t from = 0;
                        auto emit = [&](size_t a, size_t b) {
                            ParaAccum sub;
                            sub.minY = 1e30f; sub.maxY = -1e30f;
                            sub.minX = 1e30f; sub.maxX = -1e30f;
                            for (size_t k = a; k < b; k++) {
                                const auto& l = acc.lines[k];
                                sub.lines.push_back(l);
                                sub.minX = std::min(sub.minX, l.minX);
                                sub.maxX = std::max(sub.maxX, l.maxX);
                                sub.minY = std::min(sub.minY, l.minY);
                                sub.maxY = std::max(sub.maxY, l.maxY);
                                if (k > a) sub.gaps.push_back(
                                    acc.lines[k - 1].baseline - l.baseline);
                            }
                            resplit.push_back(std::move(sub));
                        };
                        for (size_t s : starts) { emit(from, s); from = s; }
                        emit(from, n);
                        didSplit = true;
                    }
                }
            }
            if (!didSplit) resplit.push_back(std::move(acc));
        }
        accums.swap(resplit);
    }

    {
        const size_t N = accums.size();
        struct ColInfo {
            std::vector<float> ys; float x0 = 0, x1 = 0;
            float numFrac = 0, digitFrac = 0, fullFrac = 0; bool multi = false;
        };
        std::vector<ColInfo> info(N);
        for (size_t i = 0; i < N; i++) {
            ParaAccum& acc = accums[i];
            info[i].multi = acc.lines.size() >= 4;
            info[i].x0 = acc.minX; info[i].x1 = acc.maxX;
            const float boxW = std::max(1.0f, acc.maxX - acc.minX);
            int numeric = 0, digit = 0, total = 0, full = 0;
            for (const ExtractedLine& l : acc.lines) {
                info[i].ys.push_back(l.baseline);
                if (l.maxX - l.minX > 0.85f * boxW) full++;
                for (const auto& r : l.runs)
                    for (char16_t c : r.text) {
                        if (c == u' ' || c == u'\t' || c == u'\n' || c == u'\r')
                            continue;
                        total++;
                        if (c >= u'0' && c <= u'9') { digit++; numeric++; }
                        else if (c == u'.' || c == u',' || c == u'%' ||
                                 c == u'+' || c == u'-' || c == u'$' ||
                                 c == u'(' || c == u')' || c == u'/')
                            numeric++;
                    }
            }
            info[i].numFrac = total ? static_cast<float>(numeric) / total : 0;
            info[i].digitFrac = total ? static_cast<float>(digit) / total : 0;
            info[i].fullFrac = acc.lines.empty()
                ? 1.0f
                : static_cast<float>(full) / static_cast<float>(acc.lines.size());
        }
        auto shareBaselines = [&](size_t a, size_t b) {
            int sh = 0;
            for (float y : info[a].ys)
                for (float z : info[b].ys)
                    if (std::abs(y - z) < 1.5f) { sh++; break; }
            const size_t mn = std::min(info[a].ys.size(), info[b].ys.size());
            return mn > 0 && sh >= 4 &&
                   static_cast<float>(sh) / static_cast<float>(mn) >= 0.7f;
        };
        auto disjoint = [&](size_t a, size_t b) {
            return info[a].x1 < info[b].x0 - 5.0f ||
                   info[b].x1 < info[a].x0 - 5.0f;
        };

        auto cellColumn = [&](size_t i) {
            return info[i].numFrac >= 0.5f || info[i].fullFrac < 0.6f;
        };

        auto dataColumn = [&](size_t i) { return info[i].digitFrac >= 0.3f; };
        std::vector<bool> split(N, false);
        for (size_t i = 0; i < N; i++) {
            if (!info[i].multi) continue;
            std::vector<size_t> grid = {i};
            bool numericGrid = dataColumn(i);
            for (size_t j = 0; j < N; j++) {
                if (j == i || !info[j].multi) continue;
                if (!disjoint(i, j) || !shareBaselines(i, j)) continue;
                grid.push_back(j);
                if (dataColumn(j)) numericGrid = true;
            }
            if (grid.size() >= 2 && numericGrid)
                for (size_t g : grid)
                    if (cellColumn(g)) split[g] = true;
        }
        bool any = false;
        for (bool b : split) any = any || b;
        if (any) {
            std::vector<ParaAccum> celled;
            celled.reserve(N);
            for (size_t i = 0; i < N; i++) {
                if (!split[i]) { celled.push_back(std::move(accums[i])); continue; }
                for (const ExtractedLine& l : accums[i].lines) {
                    ParaAccum cell;
                    cell.lines.push_back(l);
                    cell.minX = l.minX; cell.maxX = l.maxX;
                    cell.minY = l.minY; cell.maxY = l.maxY;
                    celled.push_back(std::move(cell));
                }
            }
            accums.swap(celled);
        }
    }

    for (auto& acc : accums) {
        Paragraph p;
        p.id = s.nextParaId++;

        std::vector<OwnedObject> markers;
        {
            ExtractedLine& l0 = acc.lines.front();

            bool hasRealText = false;
            for (const auto& r0 : l0.runs) {
                if (fontIsJunk(r0.font)) continue;
                for (char16_t c0 : r0.text)
                    if (!isWhitespaceChar(c0) && !isUndecodableChar(c0)) {
                        hasRealText = true;
                        break;
                    }
                if (hasRealText) break;
            }
            while (hasRealText && l0.runs.size() > 1 &&
                   isMarkerRun(l0.runs.front())) {
                markers.push_back({l0.runs.front().object, l0.runs.front().container, true});
                l0.runs.erase(l0.runs.begin());
            }
            if (!markers.empty()) {
                l0.recompute();
                acc.minX = acc.lines.front().minX;
                acc.maxX = acc.lines.front().maxX;
                acc.minY = acc.lines.front().minY;
                acc.maxY = acc.lines.front().maxY;
                for (const auto& l : acc.lines) {
                    acc.minX = std::min(acc.minX, l.minX);
                    acc.maxX = std::max(acc.maxX, l.maxX);
                    acc.minY = std::min(acc.minY, l.minY);
                    acc.maxY = std::max(acc.maxY, l.maxY);
                }
            }
        }

        p.x = acc.minX;
        p.top = acc.maxY;
        p.width = std::max(10.0f, acc.maxX - acc.minX);
        p.height = acc.maxY - acc.minY;
        p.firstBaseline = acc.lines.front().baseline;
        p.rotation = acc.lines.front().rotation;

        std::vector<const ExtractedLine*> inkLines;
        for (const auto& ln : acc.lines) {
            bool ink = false;
            for (const auto& r : ln.runs) {
                for (char16_t c : r.text)
                    if (!isWhitespaceChar(c)) { ink = true; break; }
                if (ink) break;
            }
            if (ink) inkLines.push_back(&ln);
        }
        if (inkLines.size() >= 2) {
            float leftDev = 0, rightDev = 0, rightDevAll = 0, centerDev = 0;
            float minX = inkLines.front()->minX, maxX = inkLines.front()->maxX;
            for (const auto* ln : inkLines) {
                minX = std::min(minX, ln->minX);
                maxX = std::max(maxX, ln->maxX);
            }
            const float boxCenter = (minX + maxX) / 2;
            for (size_t i = 0; i < inkLines.size(); i++) {
                const auto& ln = *inkLines[i];
                leftDev = std::max(leftDev, std::abs(ln.minX - minX));

                if (i + 1 < inkLines.size()) {
                    rightDev = std::max(rightDev, std::abs(ln.maxX - maxX));
                }
                rightDevAll = std::max(rightDevAll, std::abs(ln.maxX - maxX));
                centerDev = std::max(centerDev, std::abs((ln.minX + ln.maxX) / 2 - boxCenter));
            }
            const float tol = std::max(2.0f, inkLines.front()->dominantSize * 0.35f);

            if (leftDev <= tol && rightDev <= tol && inkLines.size() >= 3) p.fmt.align = 3;
            else if (leftDev <= tol) p.fmt.align = 0;

            else if (rightDevAll <= tol) {
                size_t maxShare = 0, modal = 0;
                for (size_t i = 0; i < inkLines.size(); i++) {
                    size_t share = 0;
                    for (size_t j = 0; j < inkLines.size(); j++) {
                        if (std::abs(inkLines[j]->minX - inkLines[i]->minX) <= tol) share++;
                    }
                    if (share > maxShare) { maxShare = share; modal = i; }
                }

                size_t offEdge = 0, firstOff = 0;
                bool allPushedRight = true;
                for (size_t j = 0; j < inkLines.size(); j++) {
                    if (std::abs(inkLines[j]->minX - inkLines[modal]->minX) > tol) {
                        if (!offEdge) firstOff = j;
                        offEdge++;
                        if (inkLines[j]->minX < inkLines[modal]->minX)
                            allPushedRight = false;
                    }
                }

                const bool shortLinePushedRight =
                    offEdge >= 1 && firstOff > 0 && allPushedRight && maxShare < 3;
                if (maxShare * 10 < inkLines.size() * 6 || shortLinePushedRight)
                    p.fmt.align = 2;
            }
            else if (centerDev <= tol) p.fmt.align = 1;
        }

        {
            std::vector<float> samples;
            std::vector<float> sizes;
            for (const auto& ln : acc.lines) {
                for (const auto& run : ln.runs) {
                    samples.insert(samples.end(), run.tcSamples.begin(), run.tcSamples.end());
                    sizes.push_back(run.size);
                }
            }
            if (samples.size() >= 8 && !sizes.empty()) {
                std::sort(samples.begin(), samples.end());
                std::sort(sizes.begin(), sizes.end());
                const float med = samples[samples.size() / 2];
                const float medSize = std::max(1.0f, sizes[sizes.size() / 2]);
                int consistent = 0;
                for (float s : samples) {
                    if (std::abs(s - med) <= std::max(0.25f, 0.03f * medSize)) consistent++;
                }
                const bool tight =
                    consistent >= static_cast<int>(samples.size() * 0.7f);
                if (tight && std::abs(med) > std::max(0.4f, 0.04f * medSize)) {
                    p.fmt.char_spacing = std::max(-2.0f, std::min(10.0f, med));
                }
            }
            p.srcCharSpacing = p.fmt.char_spacing;
        }

        if (acc.lines.size() >= 2) {
            std::vector<float> gaps;
            std::vector<float> sizes;
            for (size_t i = 0; i < acc.lines.size(); i++) {
                sizes.push_back(acc.lines[i].dominantSize);
                if (i > 0) gaps.push_back(acc.lines[i - 1].baseline - acc.lines[i].baseline);
            }
            std::sort(gaps.begin(), gaps.end());
            std::sort(sizes.begin(), sizes.end());
            float medGap = gaps[gaps.size() / 2];
            float medSize = sizes[sizes.size() / 2];
            if (medSize > 1) {
                p.fmt.line_spacing = std::max(0.6f, std::min(3.0f, medGap / medSize));
            }
        }

        if (inkLines.size() >= 2 &&
            (p.fmt.align == 0 || p.fmt.align == 3)) {
            std::vector<float> insets;
            for (size_t i = 1; i < inkLines.size(); i++)
                insets.push_back(inkLines[i]->minX - acc.minX);
            std::sort(insets.begin(), insets.end());
            const float med = insets[insets.size() / 2];
            bool consistent = inkLines[0]->minX - acc.minX < 1.5f;
            for (float v : insets)
                if (std::abs(v - med) > 2.0f) consistent = false;
            if (consistent && med > 3.0f && med < 200.0f) {
                bool rtl = false;
                for (const auto& lnn : acc.lines) rtl |= lnn.rtl;
                if (!rtl) p.fmt.hang_indent = med;
            }
        }
        p.srcHangIndent = p.fmt.hang_indent;

        bool prevHard = false;

        float carrySpace = 0;
        for (size_t li = 0; li < acc.lines.size(); li++) {
            const ExtractedLine& ln = acc.lines[li];

            std::vector<size_t> walk(ln.runs.size());
            for (size_t k = 0; k < walk.size(); k++) walk[k] = k;
            if (ln.rtl) {
                std::reverse(walk.begin(), walk.end());
                size_t is = 0;
                while (is < walk.size()) {
                    if (textIsRtl(ln.runs[walk[is]].text)) { is++; continue; }
                    size_t ie = is;
                    while (ie < walk.size() && !textIsRtl(ln.runs[walk[ie]].text)) ie++;
                    std::reverse(walk.begin() + static_cast<long>(is),
                                 walk.begin() + static_cast<long>(ie));
                    is = ie;
                }
            }

            float linePenX = 0;
            bool linePenOk = false;
            long lineOff = 0;
            for (const ParaRun& pr0 : p.runs)
                lineOff += static_cast<long>(pr0.text.size());
            for (size_t rk = 0; rk < ln.runs.size(); rk++) {
                const size_t ri = walk[rk];
                const ExtractedRun& er = ln.runs[ri];
                if (rk == 0 && !ln.rtl) {
                    linePenX = er.startX;
                    linePenOk = true;
                }
                RunStyle st = er.style;
                float baseSize = ln.dominantSize;
                float shift = er.baseline - ln.baseline;
                if (er.size < baseSize * 0.76f && std::abs(shift) > baseSize * 0.12f) {
                    st.script = shift > 0 ? 1 : -1;
                    st.size = baseSize;
                } else if (std::abs(shift) > 0.045f * baseSize &&
                           std::abs(shift) < 0.9f * baseSize) {

                    st.rise = shift;
                }

                {
                    int undec = 0;
                    for (char16_t c : er.text)
                        if (isHardUndecodableChar(c)) undec++;
                    if ((undec > 0 || fontIsJunk(er.font)) && er.object &&
                        er.rotation == 0) {
                        ParaRun pr;
                        pr.text = u"\uFFFC";
                        pr.style = st;
                        pr.originalFont = er.font;
                        pr.textUnchanged = true;
                        pr.atomicObject = er.object;
                        pr.atomicContainer = er.container;
                        pr.atomicX = er.minX;
                        pr.atomicBaseline = er.baseline;
                        pr.atomicW = std::max(1.0f, er.maxX - er.minX);
                        float bl2 = 0, bb = 0, br2 = 0, bt = 0;
                        bool haveBounds =
                            FPDFPageObj_GetBounds(er.object, &bl2, &bb, &br2, &bt) != 0;

                        if (haveBounds && er.container) {
                            FS_MATRIX fm;
                            if (FPDFPageObj_GetMatrix(er.container, &fm)) {
                                const float xs[2] = {bl2, br2}, ys[2] = {bb, bt};
                                float nl = 1e9f, nb = 1e9f, nr = -1e9f, nt = -1e9f;
                                for (float x : xs) {
                                    for (float y : ys) {
                                        const float tx = fm.a * x + fm.c * y + fm.e;
                                        const float ty = fm.b * x + fm.d * y + fm.f;
                                        nl = std::min(nl, tx); nr = std::max(nr, tx);
                                        nb = std::min(nb, ty); nt = std::max(nt, ty);
                                    }
                                }
                                bl2 = nl; bb = nb; br2 = nr; bt = nt;
                            }
                        }
                        if (haveBounds) {

                            float ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0;
                            mapRect(bl2, bb, br2, bt, &ax0, &ay0, &ax1, &ay1);
                            if (pr.atomicW < er.size * 0.5f &&
                                ax1 - ax0 > pr.atomicW) {
                                pr.atomicX = ax0;
                                pr.atomicW = std::max(1.0f, ax1 - ax0);
                            }
                            pr.atomicTop = ay1;

                            pr.atomicH = std::max(1.0f, std::abs(ay1 - ay0));

                            if (pr.atomicX < ax0 - er.size ||
                                pr.atomicX > ax1 + er.size ||
                                pr.atomicBaseline < ay0 - 2.0f * er.size ||
                                pr.atomicBaseline > ay1 + 2.0f * er.size) {
                                pr.atomicX = ax0;
                                pr.atomicW = std::max(1.0f, ax1 - ax0);
                                FS_MATRIX om{1, 0, 0, 1, 0, 0};
                                if (FPDFPageObj_GetMatrix(er.object, &om)) {
                                    float oe = om.e, of = om.f;
                                    if (er.container) {
                                        FS_MATRIX fm2;
                                        if (FPDFPageObj_GetMatrix(er.container,
                                                                  &fm2)) {
                                            const float te =
                                                fm2.a * oe + fm2.c * of + fm2.e;
                                            of = fm2.b * oe + fm2.d * of + fm2.f;
                                            oe = te;
                                        }
                                    }
                                    float mx2 = 0, my2 = 0;
                                    state.toModel(oe, of, &mx2, &my2);
                                    pr.atomicBaseline = my2;
                                } else {
                                    pr.atomicBaseline =
                                        ay0 - 0.15f * er.size;
                                }
                            }
                        } else {
                            pr.atomicTop = er.baseline + er.size * 0.8f;
                            pr.atomicH = er.size;
                        }
                        p.runs.push_back(pr);
                        p.objects.push_back({er.object, er.container,
                                              true});

                        if (rk + 1 < walk.size()) {
                            const ExtractedRun& nx0 = ln.runs[walk[rk + 1]];
                            std::u16string sep = er.trailingSeparator;

                            if (sep.empty() &&
                                !crossesGutter(er.maxX, nx0.minX,
                                               er.baseline)) {
                                float spaceW =
                                    nominalAdvance(er.font, u' ', er.size);
                                if (spaceW <= 0.0f) spaceW = 0.3f * er.size;
                                const float gap = nx0.minX - er.maxX;
                                if (gap > 0.45f * spaceW &&
                                    gap < 2.5f * er.size)
                                    sep = u" ";
                            }
                            if (!sep.empty()) {
                                ParaRun sr;
                                sr.text = sep;
                                sr.style = st;
                                sr.originalFont = er.font;

                                const float g2 = nx0.minX - er.maxX;
                                sr.srcAdv.assign(
                                    sep.size(),
                                    g2 > 0.01f
                                        ? g2 / static_cast<float>(sep.size())
                                        : -1.0f);
                                p.runs.push_back(sr);
                            }
                        }
                        continue;
                    }
                }
                std::u16string text = er.text;

                std::vector<float> adv =
                    er.adv.size() == er.text.size()
                        ? er.adv
                        : std::vector<float>(er.text.size(), -1.0f);
                if (carrySpace > 0.0f) {
                    if (!ln.rtl && !text.empty() && text.front() == u' ' &&
                        !adv.empty()) {
                        float own = adv[0];
                        if (own < 0) {
                            own = nominalAdvance(er.font, u' ', er.size);
                            if (own < 0) own = 0.3f * er.size;
                            own *= er.style.hScale > 0.01f ? er.style.hScale
                                                           : 1.0f;
                        }
                        adv[0] = own + carrySpace;
                    }
                    carrySpace = 0;
                }

                auto boundaryAdv = [&](const ExtractedRun& from,
                                       const ExtractedRun& to,
                                       std::vector<float>& a, size_t spaceIdx) {
                    if (!from.prevValid || spaceIdx == 0 || spaceIdx >= a.size())
                        return;
                    if (!from.text.empty()) {
                        const char16_t lastc = from.text.back();
                        if (lastc >= 0xDC00 && lastc <= 0xDFFF) return;
                    }
                    const float hs2 =
                        from.style.hScale > 0.01f ? from.style.hScale : 1.0f;
                    const float nom =
                        nominalAdvance(from.font, from.prevCp, from.size);
                    if (nom < 0) return;
                    const float prevAdv = nom * hs2;
                    const float sAdv = (to.startX - from.prevOriginX) - prevAdv;
                    if (sAdv > 0.05f && sAdv < 2.5f * from.size) {
                        a[spaceIdx - 1] = prevAdv;
                        a[spaceIdx] = sAdv;
                    }
                };
                if (!ln.rtl) {

                    if (ri + 1 < ln.runs.size() && er.prevValid &&
                        !text.empty() && !adv.empty()) {
                        const char16_t lastc = text.back();
                        if (!(lastc >= 0xDC00 && lastc <= 0xDFFF)) {
                            const float d =
                                ln.runs[ri + 1].startX - er.prevOriginX;

                            const float hs3 = er.style.hScale > 0.01f
                                                  ? er.style.hScale
                                                  : 1.0f;
                            const float nomL = std::max(
                                0.0f,
                                nominalAdvance(er.font, er.prevCp, er.size));
                            const std::u16string& nxTxt = ln.runs[ri + 1].text;
                            if (d > 0.02f &&
                                d < nomL * hs3 + 2.5f * er.size) {
                                if (lastc != u' ' && !nxTxt.empty() &&
                                    nxTxt.front() == u' ') {

                                    const float keep =
                                        std::min(d, nomL * hs3);
                                    adv[adv.size() - 1] = keep;
                                    carrySpace = d - keep;
                                } else {
                                    adv[adv.size() - 1] = d;
                                }
                            }
                        }
                    }
                    if (ri + 1 < ln.runs.size() && !er.trailingSeparator.empty()) {
                        const size_t sepAt = text.size();
                        text += er.trailingSeparator;
                        adv.resize(text.size(), -1.0f);

                        const size_t sn = er.trailingSeparator.size();
                        const float sgap = ln.runs[ri + 1].minX - er.maxX;

                        bool split = false;
                        if (sn >= 1 && er.prevValid && sepAt > 0) {
                            const float hs3 = er.style.hScale > 0.01f
                                                  ? er.style.hScale : 1.0f;
                            const float nom3 =
                                nominalAdvance(er.font, er.prevCp, er.size);
                            const float total3 =
                                ln.runs[ri + 1].startX - er.prevOriginX;
                            const float prevAdv3 = nom3 * hs3;
                            if (nom3 >= 0 && total3 > prevAdv3 + 0.05f &&
                                total3 < prevAdv3 + 6.0f * er.size) {
                                adv[sepAt - 1] = prevAdv3;
                                std::fill(adv.begin() + static_cast<long>(sepAt),
                                          adv.begin() + static_cast<long>(sepAt + sn),
                                          (total3 - prevAdv3) /
                                              static_cast<float>(sn));
                                split = true;
                            }
                        }
                        if (!split && sn > 1 && sgap > 0.01f)
                            std::fill(adv.begin() + static_cast<long>(sepAt),
                                      adv.begin() + static_cast<long>(sepAt + sn),
                                      sgap / static_cast<float>(sn));
                        if (er.trailingSeparator.size() == 1 &&
                            er.trailingSeparator[0] == u'\t') {
                            const float hs3 = er.style.hScale > 0.01f ? er.style.hScale : 1.0f;
                            const float nom3 = nominalAdvance(er.font, er.prevCp, er.size);
                            const float total3 = ln.runs[ri + 1].startX - er.prevOriginX;
                            const float prevAdv3 = nom3 >= 0 ? nom3 * hs3 : 0.0f;
                            if (sepAt > 0 && total3 > prevAdv3 + 0.05f) {
                                adv[sepAt - 1] = prevAdv3; adv[sepAt] = total3 - prevAdv3;
                            } else { adv[sepAt] = std::max(sgap, 1.0f); }
                        } else if (er.trailingSeparator.size() == 1 &&
                            er.trailingSeparator[0] == u' ') {
                            boundaryAdv(er, ln.runs[ri + 1], adv, sepAt);
                        }
                    }

                    if (ri + 1 < ln.runs.size() && !text.empty() &&
                        !isWhitespaceChar(text.back())) {
                        const ExtractedRun& nx = ln.runs[ri + 1];
                        float spaceW = nominalAdvance(er.font, u' ', er.size);
                        if (spaceW <= 0.0f) spaceW = 0.3f * er.size;
                        const float gap = nx.minX - er.maxX;
                        if (gap > 0.45f * spaceW && gap < 2.5f * er.size &&
                            !nx.text.empty() && nx.text.front() != u' ') {
                            text += u' ';
                            adv.push_back(-1.0f);
                            boundaryAdv(er, nx, adv, text.size() - 1);
                        }
                    }
                } else if (rk + 1 < walk.size()) {

                    const ExtractedRun& nx = ln.runs[walk[rk + 1]];
                    const ExtractedRun& carrier = er.seq < nx.seq ? er : nx;
                    if (!carrier.trailingSeparator.empty()) {
                        const size_t sepAt = text.size();
                        text += carrier.trailingSeparator;
                        adv.resize(text.size(), -1.0f);
                        const size_t sn = carrier.trailingSeparator.size();
                        const float sgap = nx.startX < er.startX
                                               ? er.minX - nx.maxX
                                               : nx.minX - er.maxX;
                        if (sn > 1 && sgap > 0.01f)
                            std::fill(adv.begin() + static_cast<long>(sepAt),
                                      adv.begin() + static_cast<long>(sepAt + sn),
                                      sgap / static_cast<float>(sn));
                    } else if (!text.empty() && !isWhitespaceChar(text.back()) &&
                               !nx.text.empty()) {

                        float spaceW = nominalAdvance(er.font, u' ', er.size);
                        if (spaceW <= 0.0f) spaceW = 0.3f * er.size;
                        const float gap = nx.startX < er.startX
                                              ? er.minX - nx.maxX
                                              : nx.minX - er.maxX;
                        if (gap > 0.45f * spaceW && gap < 2.5f * er.size) {
                            text += u' ';
                            adv.push_back(-1.0f);
                        }
                    }
                }

                if (rk == 0 && !ln.rtl && (li == 0 || prevHard) &&
                    (p.fmt.align == 0 || p.fmt.align == 3) && !text.empty() &&
                    (text.front() == u' ' || !isWhitespaceChar(text.front()))) {

                    size_t kept = 0;
                    while (kept < text.size() && text[kept] == u' ') kept++;
                    float spaceW = nominalAdvance(er.font, u' ', er.size);
                    if (spaceW <= 0.0f) spaceW = 0.3f * er.size;
                    const float hs = er.style.hScale > 0.01f ? er.style.hScale : 1.0f;
                    spaceW *= hs;
                    const float inset = ln.minX - acc.minX;
                    if (spaceW > 0.01f && inset > 0.6f * spaceW) {
                        const int target = std::max(1, std::min(80,
                            static_cast<int>(std::lround(inset / spaceW))));
                        if (target > static_cast<int>(kept)) {
                            text.insert(text.begin(),
                                        static_cast<size_t>(target - kept), u' ');
                            adv.insert(adv.begin(),
                                       static_cast<size_t>(target - kept),
                                       inset / static_cast<float>(target));

                            linePenX -= static_cast<float>(target - kept) *
                                        (inset / static_cast<float>(target));
                        }
                    }
                }
                if (!p.runs.empty() && !p.runs.back().atomicObject &&
                    p.runs.back().style.samePaint(st) &&
                    p.runs.back().originalFont == er.font) {
                    p.runs.back().text += text;
                    p.runs.back().srcAdv.insert(p.runs.back().srcAdv.end(),
                                                adv.begin(), adv.end());
                } else {
                    ParaRun pr;
                    pr.text = text;
                    pr.srcAdv = adv;
                    pr.style = st;
                    pr.originalFont = er.font;
                    pr.textUnchanged = true;
                    p.runs.push_back(pr);
                }
                p.objects.push_back({er.object, er.container});
            }
            for (FPDF_PAGEOBJECT deco : ln.decorations) {
                p.objects.push_back({deco, nullptr});
            }

            bool boundaryHard = false;
            if (li + 1 < acc.lines.size() && !p.runs.empty()) {
                std::u16string& t = p.runs.back().text;

                const size_t vis = t.find_last_not_of(u" \t");
                char16_t last = vis == std::u16string::npos ? u' ' : t[vis];
                bool cjk = (last >= 0x2E80 && last <= 0x9FFF) ||
                           (last >= 0xF900 && last <= 0xFAFF) ||
                           (last >= 0x3040 && last <= 0x30FF);
                if (vis != std::u16string::npos && last != u'-') {

                    const ExtractedLine& next = acc.lines[li + 1];

                    std::u16string nextText;
                    for (const auto& r : next.runs) {
                        nextText += r.text;
                        nextText += r.trailingSeparator;
                    }
                    size_t firstSpace = nextText.find_first_of(u" \t");
                    size_t firstWordLen =
                        firstSpace == std::u16string::npos ? nextText.size() : firstSpace;

                    size_t tabN = static_cast<size_t>(
                        std::count(nextText.begin(), nextText.end(), u'\t'));
                    float tabAdv = 0;
                    for (const auto& r2 : next.runs)
                        for (size_t ci2 = 0; ci2 < r2.text.size() && ci2 < r2.adv.size(); ci2++)
                            if (r2.text[ci2] == u'\t' && r2.adv[ci2] > 0) tabAdv += r2.adv[ci2];
                    float nextVisible = std::max(1.0f,
                        static_cast<float>(nextText.size()) - static_cast<float>(tabN));
                    float avgCharW = std::max(0.1f,
                        ((next.maxX - next.minX) - tabAdv) / nextVisible);
                    float firstWordW = firstWordLen * avgCharW;
                    float slack = std::max(2.0f, avgCharW * 1.5f);

                    bool wordWouldHaveFit;
                    if (p.fmt.align == 2) {
                        wordWouldHaveFit =
                            ln.minX - avgCharW - firstWordW >= acc.minX - slack;
                    } else if (p.fmt.align == 1) {
                        wordWouldHaveFit =
                            (acc.maxX - ln.maxX) + (ln.minX - acc.minX) >=
                            firstWordW + avgCharW - slack;
                    } else {
                        wordWouldHaveFit =
                            ln.maxX + avgCharW + firstWordW <= acc.maxX + slack;
                    }

                    bool leaderTail = false;
                    {
                        size_t e = t.size();
                        while (e > 0 && isWhitespaceChar(t[e - 1])) e--;
                        size_t d = e;
                        while (d > 0 && t[d - 1] >= u'0' && t[d - 1] <= u'9') d--;
                        if (d < e && e - d <= 4) {
                            int dots = 0;
                            size_t k = d;
                            while (k > 0 && dots < 3) {
                                k--;
                                if (t[k] == u'.') dots++;
                                else if (!isWhitespaceChar(t[k])) break;
                            }
                            leaderTail = dots >= 3;
                        }
                    }

                    bool fillTail = false;
                    {
                        size_t e = t.size();
                        while (e > 0 && isWhitespaceChar(t[e - 1])) e--;
                        size_t u = e;
                        while (u > 0 && t[u - 1] == u'_') u--;
                        fillTail = e - u >= 4;
                    }
                    const ExtractedLine& nextLn = acc.lines[li + 1];
                    const float szA = ln.dominantSize, szB = nextLn.dominantSize;
                    const bool sizeStep =
                        szA > 0.5f && szB > 0.5f &&
                        (szB < szA * 0.95f || szB > szA * 1.05f);

                    const bool indentStart =
                        (p.fmt.align == 0 || p.fmt.align == 3) &&
                        p.fmt.hang_indent <= 0.01f && !ln.rtl && !nextLn.rtl &&
                        ln.minX - acc.minX < 1.5f &&
                        nextLn.minX - acc.minX > 0.5f * szB &&
                        nextLn.minX - acc.minX < 0.25f * (acc.maxX - acc.minX);
                    bool hardBreak =
                        !cjk && (wordWouldHaveFit || leaderTail || fillTail ||
                                 sizeStep || indentStart);

                    std::vector<float>& ta = p.runs.back().srcAdv;
                    if (p.runs.back().atomicObject) {

                        if (hardBreak || (!cjk && !isWhitespaceChar(last))) {
                            ParaRun jr;
                            jr.text = hardBreak ? u"\n" : u"\u00AD";
                            jr.style = p.runs.back().style;
                            jr.originalFont = p.runs.back().originalFont;
                            jr.srcAdv.assign(1, -1.0f);
                            boundaryHard = hardBreak;
                            p.runs.push_back(jr);
                        }
                    } else if (hardBreak) {

                        t.erase(vis + 1);
                        if (ta.size() > t.size()) ta.resize(t.size());
                        if (!ta.empty()) ta.back() = -1.0f;
                        t.push_back(u'\n');
                        ta.resize(t.size(), -1.0f);
                        boundaryHard = true;
                    } else if (!cjk && !isWhitespaceChar(t.back())) {
                        t.push_back(u' ');
                        ta.resize(t.size(), -1.0f);
                    }
                }
            }
            prevHard = boundaryHard;
            p.lines.push_back({ln.baseline, ln.minX, ln.maxX - ln.minX,
                               linePenX, linePenOk, lineOff});
        }

        for (const OwnedObject& m : markers) p.objects.push_back(m);
        p.hasMarker = !markers.empty();

        for (const OwnedObject& oo : p.objects) {
            if (!oo.object ||
                FPDFPageObj_GetType(oo.object) != FPDF_PAGEOBJ_TEXT)
                continue;
            const int nm = FPDFPageObj_CountMarks(oo.object);
            if (nm <= 0) continue;
            for (int mi = 0; mi < nm; mi++) {
                FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(oo.object, mi);
                if (!mk) continue;
                ContentMark cm;
                unsigned long need = 0;
                char16_t nbuf[64] = {0};
                if (FPDFPageObjMark_GetName(
                        mk, reinterpret_cast<FPDF_WCHAR*>(nbuf),
                        sizeof(nbuf), &need) &&
                    need >= 2) {
                    cm.name = utf16ToUtf8(std::u16string(nbuf));
                }
                if (cm.name.empty()) continue;
                const int np = FPDFPageObjMark_CountParams(mk);
                for (int pi2 = 0; pi2 < np; pi2++) {
                    char16_t kbuf[64] = {0};
                    if (!FPDFPageObjMark_GetParamKey(
                            mk, pi2, reinterpret_cast<FPDF_WCHAR*>(kbuf),
                            sizeof(kbuf), &need))
                        continue;
                    const std::string key =
                        utf16ToUtf8(std::u16string(kbuf));
                    const int vt =
                        FPDFPageObjMark_GetParamValueType(mk, key.c_str());
                    if (vt == FPDF_OBJECT_NUMBER) {
                        int v = 0;
                        if (FPDFPageObjMark_GetParamIntValue(mk, key.c_str(),
                                                             &v))
                            cm.intParams.push_back({key, v});
                    } else if (vt == FPDF_OBJECT_STRING ||
                               vt == FPDF_OBJECT_NAME) {
                        char16_t vbuf[256] = {0};
                        if (FPDFPageObjMark_GetParamStringValue(
                                mk, key.c_str(),
                                reinterpret_cast<FPDF_WCHAR*>(vbuf),
                                sizeof(vbuf), &need)) {
                            cm.strParams.push_back(
                                {key, utf16ToUtf8(std::u16string(vbuf))});
                        }
                    }
                }

                bool hasMcid = false;
                for (const auto& [k, v] : cm.intParams)
                    if (k == "MCID") hasMcid = true;
                if (!(hasMcid || cm.name == "OC")) continue;
                std::vector<std::pair<std::string, std::string>> keep;
                for (auto& kv : cm.strParams) {
                    if (kv.first == "ActualText" || kv.first == "Alt" ||
                        kv.first == "E")
                        continue;
                    keep.push_back(std::move(kv));
                }
                cm.strParams = std::move(keep);
                p.marks.push_back(std::move(cm));
            }
            if (!p.marks.empty())
                break;
        }

        {
            unsigned int th = 5381;
            for (const auto& r : p.runs)
                for (char16_t c : r.text)
                    if (c != u' ' && c != u'\t' && c != 0x00A0 &&
                        c != u'\n' && c != u'\r')
                        th = th * 33u + static_cast<unsigned int>(c);
            bool applied = false;
            for (const OwnedObject& oo : p.objects) {
                if (applied) break;
                if (!oo.object ||
                    FPDFPageObj_GetType(oo.object) != FPDF_PAGEOBJ_TEXT)
                    continue;
                const int nm2 = FPDFPageObj_CountMarks(oo.object);
                for (int mi = 0; mi < nm2 && !applied; mi++) {
                    FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(oo.object, mi);
                    if (!mk) continue;
                    unsigned long need2 = 0;
                    char16_t nbuf2[24] = {0};
                    if (!FPDFPageObjMark_GetName(
                            mk, reinterpret_cast<FPDF_WCHAR*>(nbuf2),
                            sizeof(nbuf2), &need2))
                        continue;
                    if (utf16ToUtf8(std::u16string(nbuf2)) != "ECFmt") continue;
                    char16_t vbuf2[240] = {0};
                    if (!FPDFPageObjMark_GetParamStringValue(
                            mk, "f", reinterpret_cast<FPDF_WCHAR*>(vbuf2),
                            sizeof(vbuf2), &need2))
                        continue;
                    const std::string v = utf16ToUtf8(std::u16string(vbuf2));
                    int a2 = 0, d3 = 0, ll2 = 0;
                    float ls2 = 0, cs2 = 0, ps2 = 0, ws2 = 0, fi2 = 0, hi2 = 0;
                    unsigned int h2 = 0;
                    if (sscanf(v.c_str(),
                               "1|a%d|ls%f|cs%f|ps%f|ws%f|fi%f|hi%f|d%d|ll%d|"
                               "h%x",
                               &a2, &ls2, &cs2, &ps2, &ws2, &fi2, &hi2, &d3,
                               &ll2, &h2) == 10 &&
                        h2 == th) {
                        p.fmt.align = std::max(0, std::min(3, a2));
                        if (ls2 > 0.3f && ls2 < 6.0f) p.fmt.line_spacing = ls2;
                        if (cs2 > -5.0f && cs2 < 50.0f) {
                            p.fmt.char_spacing = cs2;
                            p.srcCharSpacing = cs2;
                        }
                        if (ps2 >= 0.0f && ps2 < 500.0f)
                            p.fmt.para_spacing = ps2;
                        if (ws2 > -20.0f && ws2 < 200.0f)
                            p.fmt.word_spacing = ws2;
                        if (fi2 >= 0.0f && fi2 < 500.0f)
                            p.fmt.first_indent = fi2;
                        if (hi2 >= 0.0f && hi2 < 500.0f) {
                            p.fmt.hang_indent = hi2;
                            p.srcHangIndent = hi2;
                        }
                        p.fmt.dir = (d3 >= 0 && d3 <= 2) ? d3 : 0;
                        p.fmt.list_level = std::max(0, std::min(8, ll2));
                        applied = true;
                    }
                }
            }
        }

        {
            bool allAtomic2 = !p.runs.empty();
            for (const auto& r : p.runs)
                if (!r.atomicObject && r.text.find_first_not_of(u" \n\t") !=
                                           std::u16string::npos)
                    allAtomic2 = false;
            if (allAtomic2) {
                float mnX = 1e9f, mxX = -1e9f, mnY = 1e9f, mxY = -1e9f;
                int na = 0;
                for (const auto& r : p.runs) {
                    if (!r.atomicObject) continue;
                    na++;
                    mnX = std::min(mnX, r.atomicX);
                    mxX = std::max(mxX, r.atomicX + r.atomicW);
                    mxY = std::max(mxY, r.atomicTop);
                    mnY = std::min(mnY, r.atomicTop - r.atomicH);
                }
                if (na > 0 && mxX - mnX > p.width) {
                    p.x = mnX;
                    p.top = mxY;
                    p.width = mxX - mnX;
                    p.height = mxY - mnY;
                    if (p.lines.size() == 1) {
                        p.lines.front().x = mnX;
                        p.lines.front().w = mxX - mnX;
                    }
                }
            }
        }

        int printable = 0, undecodable = 0;
        bool clipText = false;
        for (const auto& run : p.runs) {

            if (run.style.renderMode >= 4) clipText = true;
            for (char16_t c : run.text) {
                if (c == u'\n' || c == u'\r') continue;
                if (isHardUndecodableChar(c)) undecodable++;
                else if (!isWhitespaceChar(c)) printable++;
            }
        }
        p.editable = (undecodable == 0) && (printable > 0) && !clipText;
        p.lockReason = p.editable ? 0 : clipText ? 2 : 1;

        if (p.editable) {
            std::map<FPDF_PAGEOBJECT, int> ourChildren;
            for (const OwnedObject& oo : p.objects) {

                if (oo.container && !oo.preserved) ourChildren[oo.container]++;
            }
            std::vector<FPDF_PAGEOBJECT> flat;
            std::set<FPDF_PAGEOBJECT> explode;
            bool canFlatten = true;
            bool unwrap = false;
            for (const auto& [form, mine] : ourChildren) {
                auto cnt = formChildCount.find(form);
                FPDF_PAGEOBJECT drop = form;
                if (!pageLevelForms.count(form)) {

                    FPDF_PAGEOBJECT anc = form;
                    std::set<FPDF_PAGEOBJECT> path;
                    while (anc && !pageLevelForms.count(anc)) {

                        if (formShared.count(anc) || !path.insert(anc).second) {
                            anc = nullptr;
                            break;
                        }
                        auto pit = formParent.find(anc);
                        anc = pit == formParent.end() ? nullptr : pit->second;
                    }
                    if (!anc || formShared.count(anc)) {
                        canFlatten = false;
                        break;
                    }
                    explode.insert(path.begin(), path.end());
                    drop = anc;
                }

                if (formShared.count(drop)) {
                    canFlatten = false;
                    break;
                }

                (void)cnt;

                unwrap = true;
                if (std::find(flat.begin(), flat.end(), drop) == flat.end())
                    flat.push_back(drop);
            }
            if (!canFlatten) {
                p.editable = false;
                p.lockReason = 3;
            } else {
                p.flattenForms = std::move(flat);
                p.explodeForms = std::move(explode);
                p.unwrapsForms = unwrap;
            }
        }

        state.paras.push_back(std::move(p));
    }

    if (!tocBands.empty()) {
        auto inBand = [&](const Paragraph& q) {
            const float mid = q.top - q.height * 0.5f;
            for (const auto& t : tocBands)
                if (mid >= t.first && mid <= t.second) return true;
            return false;
        };
        int nextBlock = 0;
        for (size_t i = 0; i + 1 < state.paras.size(); i++) {
            Paragraph& a = state.paras[i];
            Paragraph& b = state.paras[i + 1];
            if (!a.editable || !b.editable || a.vertical || b.vertical) continue;
            if (std::abs(a.rotation - b.rotation) > 0.01f) continue;
            if (!inBand(a) || !inBand(b)) continue;
            const float hgt = std::max(4.0f, std::max(a.height, b.height));
            const float gap = (a.top - a.height) - b.top;
            if (gap < -hgt || gap > 2.0f * hgt) continue;
            const float dl = std::abs(a.x - b.x);
            const float dr = std::abs((a.x + a.width) - (b.x + b.width));
            if (std::min(dl, dr) > 4.0f * hgt) continue;
            if (!a.blockId) a.blockId = ++nextBlock;
            b.blockId = a.blockId;
        }
    }

    {
        std::map<FPDF_PAGEOBJECT, size_t> ownerOf;
        for (size_t pi = 0; pi < state.paras.size(); pi++)
            for (const auto& oo : state.paras[pi].objects)
                if (oo.object) ownerOf.emplace(oo.object, pi);

        struct OwnedGlyph { float x, y; size_t pi; };
        std::vector<OwnedGlyph> ownedGlyphs;
        for (const auto& [obj, pi] : ownerOf) {
            if (FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;
            FS_MATRIX m{1, 0, 0, 1, 0, 0};
            if (!FPDFPageObj_GetMatrix(obj, &m)) continue;
            for (const OrigGlyph& g : readOrigGlyphs(obj)) {
                ownedGlyphs.push_back({m.a * g.x + m.c * g.y + m.e,
                                       m.b * g.x + m.d * g.y + m.f, pi});
            }
        }
        if (!ownedGlyphs.empty()) {
            for (const auto& [obj, container] : containerOf) {
                if (ownerOf.count(obj)) continue;
                if (FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;
                const std::vector<OrigGlyph> g = readOrigGlyphs(obj);
                if (g.empty()) continue;
                FS_MATRIX m{1, 0, 0, 1, 0, 0};
                if (!FPDFPageObj_GetMatrix(obj, &m)) continue;
                const float ux = m.a * g[0].x + m.c * g[0].y + m.e;
                const float uy = m.b * g[0].x + m.d * g[0].y + m.f;
                for (const OwnedGlyph& og : ownedGlyphs) {
                    if (std::abs(og.x - ux) <= 2.0f &&
                        std::abs(og.y - uy) <= 2.0f) {
                        state.paras[og.pi].objects.push_back(
                            {obj, container,  false});
                        ownerOf.emplace(obj, og.pi);
                        break;
                    }
                }
            }
        }

        {
            auto squash = [](const std::u16string& t) {
                std::u16string o2;
                for (char16_t c : t)
                    if (c > u' ') o2 += c;
                return o2;
            };

            FPDF_TEXTPAGE tp2 = nullptr;
            std::vector<std::u16string> paraText(state.paras.size());

            struct Cand {
                FPDF_PAGEOBJECT obj;
                FPDF_PAGEOBJECT container;
                size_t fromPara;
            };
            std::vector<Cand> cands;
            for (const auto& [obj, container] : containerOf) {
                if (ownerOf.count(obj)) continue;
                if (FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) continue;
                cands.push_back({obj, container, SIZE_MAX});
            }
            for (size_t pi = 0; pi < state.paras.size(); pi++) {
                Paragraph& q = state.paras[pi];
                if (q.runs.empty() || !q.objects.size()) continue;
                bool blankOnly = true;
                for (const auto& r2 : q.runs) {
                    if (r2.atomicObject) { blankOnly = false; break; }
                    for (char16_t c : r2.text)
                        if (c != u'\n' && c != u'\r' && !isWhitespaceChar(c)) {
                            blankOnly = false;
                            break;
                        }
                    if (!blankOnly) break;
                }
                if (!blankOnly) continue;
                for (const auto& oo : q.objects) {
                    if (oo.object &&
                        FPDFPageObj_GetType(oo.object) == FPDF_PAGEOBJ_TEXT &&
                        !oo.preserved) {
                        cands.push_back({oo.object, oo.container, pi});
                    }
                }
            }
            std::set<FPDF_PAGEOBJECT> donated;
            for (const Cand& cand : cands) {
                FPDF_PAGEOBJECT obj = cand.obj;
                FPDF_PAGEOBJECT container = cand.container;
                float l = 0, b = 0, r = 0, t2 = 0;
                if (!FPDFPageObj_GetBounds(obj, &l, &b, &r, &t2)) continue;
                float mx0 = 0, my0 = 0, mx1 = 0, my1 = 0;
                mapRect(l, b, r, t2, &mx0, &my0, &mx1, &my1);
                const float cx2 = (mx0 + mx1) * 0.5f;
                const float cy2 = (my0 + my1) * 0.5f;
                if (!tp2) tp2 = FPDFText_LoadPage(page);
                if (!tp2) break;

                std::u16string txt;
                {
                    unsigned long len =
                        FPDFTextObj_GetText(obj, tp2, nullptr, 0);
                    if (len >= 2) {
                        std::vector<unsigned short> buf2(len / 2 + 1, 0);
                        unsigned long got =
                            FPDFTextObj_GetText(obj, tp2, buf2.data(), len);
                        if (got >= 2)
                            txt.assign(reinterpret_cast<char16_t*>(buf2.data()),
                                       got / 2 - 1);
                    }
                }
                const std::u16string sq = squash(txt);
                if (sq.size() < 3) continue;
                for (size_t pi = 0; pi < state.paras.size(); pi++) {
                    if (pi == cand.fromPara) continue;
                    Paragraph& q = state.paras[pi];
                    if (!q.editable || q.runs.empty()) continue;
                    if (cx2 < q.x - 1.0f || cx2 > q.x + q.width + 1.0f)
                        continue;
                    if (cy2 > q.top + 1.0f || cy2 < q.top - q.height - 1.0f)
                        continue;
                    if (paraText[pi].empty()) {
                        std::u16string all;
                        for (const auto& r2 : q.runs) all += r2.text;
                        paraText[pi] = squash(all);
                    }
                    if (paraText[pi].find(sq) == std::u16string::npos)
                        continue;
                    q.objects.push_back({obj, container,  false});
                    ownerOf.emplace(obj, pi);
                    if (cand.fromPara != SIZE_MAX) donated.insert(obj);
                    break;
                }
            }

            if (!donated.empty()) {
                for (Paragraph& q : state.paras) {
                    q.objects.erase(
                        std::remove_if(q.objects.begin(), q.objects.end(),
                                       [&](const OwnedObject& oo) {
                                           return oo.object &&
                                                  donated.count(oo.object) &&
                                                  ownerOf.count(oo.object) &&
                                                  &state.paras[ownerOf
                                                       [oo.object]] != &q;
                                       }),
                        q.objects.end());
                }
            }
            if (tp2) FPDFText_ClosePage(tp2);
        }
    }

    {
        std::set<FPDF_PAGEOBJECT> tracked;
        for (const auto& q : state.paras) {
            for (const auto& oo : q.objects) tracked.insert(oo.object);
            for (const auto& r : q.runs)
                if (r.atomicObject) tracked.insert(r.atomicObject);
        }
        struct Loose {
            FPDF_PAGEOBJECT obj;
            float l, b, r, t;
        };
        std::vector<Loose> loose;
        const int n2 = FPDFPage_CountObjects(page);
        for (int i = 0; i < n2; i++) {
            FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
            if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_TEXT) continue;
            if (tracked.count(o)) continue;
            float l = 0, b = 0, r = 0, t = 0;
            if (!FPDFPageObj_GetBounds(o, &l, &b, &r, &t)) continue;
            mapRect(l, b, r, t, &l, &b, &r, &t);
            if (r - l < 0.3f || t - b < 0.3f) continue;
            loose.push_back({o, l, b, r, t});
        }
        std::sort(loose.begin(), loose.end(), [](const Loose& a, const Loose& b2) {

            const int qa = static_cast<int>(std::lround(a.b / 3.0f));
            const int qb = static_cast<int>(std::lround(b2.b / 3.0f));
            if (qa != qb) return qa > qb;
            return a.l < b2.l;
        });

        size_t i2 = 0;
        while (i2 < loose.size()) {
            size_t j2 = i2 + 1;
            const float h0 = loose[i2].t - loose[i2].b;
            while (j2 < loose.size() &&
                   std::abs(loose[j2].b - loose[i2].b) < std::max(2.0f, h0 * 0.4f) &&
                   loose[j2].l - loose[j2 - 1].r < std::max(6.0f, h0 * 2.0f))
                j2++;
            if (j2 - i2 >= 2) {
                Paragraph np;
                np.id = s.nextParaId++;
                float minX = 1e9f, maxX = -1e9f, minY = 1e9f, maxY = -1e9f;
                for (size_t k = i2; k < j2; k++) {
                    const Loose& g = loose[k];
                    minX = std::min(minX, g.l);
                    maxX = std::max(maxX, g.r);
                    minY = std::min(minY, g.b);
                    maxY = std::max(maxY, g.t);
                }
                const float baseline2 = minY + (maxY - minY) * 0.08f;
                for (size_t k = i2; k < j2; k++) {
                    const Loose& g = loose[k];
                    ParaRun pr;
                    pr.text = u"\uFFFC";
                    pr.style.size = std::max(4.0f, maxY - minY);
                    pr.style.family = "";
                    pr.textUnchanged = true;
                    pr.atomicObject = g.obj;
                    pr.atomicX = g.l;
                    pr.atomicBaseline = baseline2;
                    pr.atomicW = std::max(1.0f, g.r - g.l);
                    pr.atomicTop = g.t;
                    pr.atomicH = std::max(1.0f, g.t - g.b);
                    np.runs.push_back(std::move(pr));
                    np.objects.push_back({g.obj, nullptr,  true});
                }
                np.x = minX;
                np.top = maxY;
                np.width = std::max(10.0f, maxX - minX);
                np.height = maxY - minY;
                np.firstBaseline = baseline2;
                np.lines.push_back({baseline2, minX, maxX - minX});
                np.editable = true;
                np.lockReason = 0;

                for (auto it2 = state.paras.begin(); it2 != state.paras.end();) {
                    Paragraph& q = *it2;
                    const bool allAtomic =
                        !q.runs.empty() &&
                        std::all_of(q.runs.begin(), q.runs.end(),
                                    [](const ParaRun& r) {
                                        return r.atomicObject != nullptr;
                                    });
                    const bool sameBand =
                        allAtomic && q.lines.size() == 1 &&
                        std::abs(q.lines.front().baseline - baseline2) <
                            std::max(3.0f, (maxY - minY) * 0.6f) &&
                        q.x < maxX + 20.0f && q.x + q.width > minX - 20.0f;
                    if (sameBand) {
                        for (auto& r : q.runs) np.runs.push_back(std::move(r));
                        for (auto& oo : q.objects) np.objects.push_back(oo);
                        np.x = std::min(np.x, q.x);
                        np.width = std::max(np.width,
                                            q.x + q.width - np.x);
                        it2 = state.paras.erase(it2);
                    } else {
                        ++it2;
                    }
                }
                std::sort(np.runs.begin(), np.runs.end(),
                          [](const ParaRun& a, const ParaRun& b2) {
                              return a.atomicX < b2.atomicX;
                          });
                np.lines.front().x = np.x;
                np.lines.front().w = np.width;
                state.paras.push_back(std::move(np));
            }
            i2 = j2;
        }
    }

    {
        auto domSizeOf = [](const Paragraph& q) {
            std::vector<float> sz;
            for (const auto& r0 : q.runs)
                if (r0.style.size > 1) sz.push_back(r0.style.size);
            if (sz.empty()) return 12.0f;
            std::sort(sz.begin(), sz.end());
            return sz[sz.size() / 2];
        };
        auto pitchOf = [&](const Paragraph& q, float dom) {
            std::vector<float> g;
            for (size_t i = 1; i < q.lines.size(); i++)
                g.push_back(q.lines[i - 1].baseline - q.lines[i].baseline);
            if (g.empty()) return 1.25f * dom;
            std::sort(g.begin(), g.end());
            return g[g.size() / 2];
        };

        auto looksHeading = [](const Paragraph& q) {
            if (q.lines.size() != 1) return false;
            std::u16string t;
            for (const auto& r0 : q.runs) t += r0.text;
            while (!t.empty() && (t.back() == u' ' || t.back() == u'\n'))
                t.pop_back();
            if (t.empty() || t.size() > 60) return false;
            const char16_t c = t.back();
            return c != u'.' && c != u',' && c != u';' && c != u':' &&
                   c != u'!' && c != u'?' && c != u')' && c != u'”' &&
                   c != u'"';
        };

        auto isLeaderRow = [](const Paragraph& q) {
            int dots = 0;
            for (const auto& r0 : q.runs)
                for (char16_t c : r0.text) {
                    if (c == u'.') { if (++dots >= 4) return true; }
                    else if (c != u' ') dots = 0;
                }
            return false;
        };
        auto sameFace = [](const Paragraph& a, const Paragraph& b) {
            const RunStyle* sa = nullptr;
            const RunStyle* sb = nullptr;
            for (const auto& r0 : a.runs)
                if (!r0.atomicObject) { sa = &r0.style; break; }
            for (const auto& r0 : b.runs)
                if (!r0.atomicObject) { sb = &r0.style; break; }
            if (!sa || !sb) return false;
            return sa->family == sb->family && sa->bold == sb->bold &&
                   sa->italic == sb->italic;
        };
        bool mergedAny = true;
        while (mergedAny) {
            mergedAny = false;
            for (size_t ai = 0; ai < state.paras.size() && !mergedAny; ai++) {
                Paragraph& A = state.paras[ai];
                if (!A.editable || A.vertical || A.rotation != 0 ||
                    A.lines.empty() || A.hasMarker || isLeaderRow(A))
                    continue;
                const float domA = domSizeOf(A);
                const float pitchA = pitchOf(A, domA);
                const float aBottom = A.lines.back().baseline;
                for (size_t bi = 0; bi < state.paras.size(); bi++) {
                    if (bi == ai) continue;
                    Paragraph& B = state.paras[bi];
                    if (!B.editable || B.vertical || B.rotation != 0 ||
                        B.lines.empty() || B.hasMarker || isLeaderRow(B))
                        continue;

                    if (std::abs(A.x - B.x) > 1.5f) continue;
                    if (std::abs(A.width - B.width) >
                        0.12f * std::max(A.width, B.width))
                        continue;

                    const float gap = aBottom - B.lines.front().baseline;
                    if (gap <= 0.25f * domA || gap > 1.45f * pitchA) continue;
                    const float domB = domSizeOf(B);
                    if (std::abs(domA - domB) > 0.10f * std::max(domA, domB))
                        continue;
                    if (A.fmt.align != B.fmt.align) continue;
                    if (!sameFace(A, B)) continue;
                    if (looksHeading(A) || looksHeading(B)) continue;

                    const int loId = std::min(A.id, B.id);
                    const int hiId = std::max(A.id, B.id);
                    bool interleaved = false;
                    for (const auto& P : state.paras) {
                        if (P.id <= loId || P.id >= hiId) continue;
                        if (std::abs(P.x - A.x) > 20.0f) { interleaved = true; break; }
                    }
                    if (!interleaved) continue;

                    if (!A.runs.empty() && !B.runs.empty()) {
                        std::u16string& tail = A.runs.back().text;
                        if (!tail.empty() && tail.back() != u'\n' &&
                            tail.back() != u' ')
                            tail.push_back(u' ');
                    }

                    long base = 0;
                    for (const ParaRun& r0 : A.runs)
                        base += static_cast<long>(r0.text.size());
                    for (auto& r0 : B.runs) A.runs.push_back(std::move(r0));
                    for (auto& L : B.lines) {
                        L.off += base;
                        A.lines.push_back(L);
                    }
                    for (auto& oo : B.objects) A.objects.push_back(oo);
                    if (A.marks.empty())
                        for (auto& mk : B.marks) A.marks.push_back(mk);
                    const float newBottom =
                        std::min(A.top - A.height, B.top - B.height);
                    A.x = std::min(A.x, B.x);
                    A.width = std::max(A.width, B.width);
                    A.top = std::max(A.top, B.top);
                    A.height = A.top - newBottom;
                    state.paras.erase(state.paras.begin() +
                                      static_cast<long>(bi));
                    mergedAny = true;
                    break;
                }
            }
        }
    }

    {
        struct ImRect {
            float l, r, b, t;
        };
        std::vector<ImRect> images;
        const int nObj = FPDFPage_CountObjects(page);
        for (int i = 0; i < nObj; i++) {
            FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
            if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_IMAGE) continue;
            float l = 0, b = 0, r = 0, t = 0;
            if (!FPDFPageObj_GetBounds(o, &l, &b, &r, &t)) continue;
            mapRect(l, b, r, t, &l, &b, &r, &t);
            if (r - l < 12.0f || t - b < 12.0f) continue;
            images.push_back({l, r, b, t});
        }
        for (auto& P : state.paras) {
            if (!images.empty() && P.rotation == 0 && P.editable &&
                P.lines.size() >= 2) {
                float domSize = 12.0f;
                {
                    std::vector<float> sz;
                    for (const auto& r0 : P.runs)
                        if (r0.style.size > 1) sz.push_back(r0.style.size);
                    if (!sz.empty()) {
                        std::sort(sz.begin(), sz.end());
                        domSize = sz[sz.size() / 2];
                    }
                }
                for (const ImRect& im : images) {
                    if (im.r <= P.x + 1 || im.l >= P.x + P.width - 1) continue;
                    if (im.t <= P.top - P.height || im.b >= P.top) continue;
                    std::vector<float> starts, ends;
                    for (const auto& L : P.lines) {

                        if (L.baseline > im.t + 2.0f ||
                            L.baseline + domSize < im.b)
                            continue;
                        if (std::abs(L.x - im.r) <= 30.0f &&
                            L.x > P.x + 4.0f) {
                            starts.push_back(L.x);
                        } else if (std::abs((L.x + L.w) - im.l) <= 30.0f &&
                                   L.x + L.w < P.x + P.width - 4.0f) {
                            ends.push_back(L.x + L.w);
                        }
                    }
                    auto median = [](std::vector<float>& v) {
                        std::sort(v.begin(), v.end());
                        return v[v.size() / 2];
                    };
                    if (!starts.empty() && starts.size() >= ends.size()) {

                        P.obstacles.push_back({im.l - 2.0f,
                                               median(starts) - 0.01f,
                                               im.t + 2.0f, im.b - 2.0f});
                    } else if (!ends.empty()) {
                        P.obstacles.push_back({median(ends) + 0.01f,
                                               im.r + 2.0f, im.t + 2.0f,
                                               im.b - 2.0f});
                    }
                }
            }
        }
    }

    {
        std::map<FPDF_PAGEOBJECT, std::vector<size_t>> owners;
        for (size_t pi = 0; pi < state.paras.size(); pi++)
            for (const OwnedObject& oo : state.paras[pi].objects)
                if (oo.object && !oo.preserved &&
                    FPDFPageObj_GetType(oo.object) == FPDF_PAGEOBJ_TEXT)
                    owners[oo.object].push_back(pi);
        std::set<size_t> affected;
        for (auto& [obj, pis] : owners) {
            if (pis.size() < 2) continue;

            for (size_t pi : pis) affected.insert(pi);
        }

        for (size_t pi : affected) {
            Paragraph& P = state.paras[pi];
            if (!P.editable || P.vertical || P.runs.empty()) continue;
            P.sharesObjects = true;
        }
    }

    for (Paragraph& p2 : state.paras) {
        for (size_t i = 0; i < p2.runs.size(); i++) {
            ParaRun& r = p2.runs[i];
            if (!r.atomicObject || r.text.size() <= 1) continue;
            const size_t at = r.text.find(u'￼');
            if (at == std::u16string::npos) continue;
            std::u16string before = r.text.substr(0, at);
            std::u16string after = r.text.substr(at + 1);
            r.text = u"￼";
            r.srcAdv.clear();
            auto plain = [&](std::u16string t) {
                ParaRun n;
                n.text = std::move(t);
                n.style = r.style;
                n.originalFont = r.originalFont;
                return n;
            };
            if (!after.empty())
                p2.runs.insert(p2.runs.begin() + static_cast<long>(i) + 1,
                               plain(std::move(after)));
            if (!before.empty()) {
                p2.runs.insert(p2.runs.begin() + static_cast<long>(i),
                               plain(std::move(before)));
                i++;
            }
        }
    }

    {
        auto blank = [](const Paragraph& q) {
            if (q.runs.empty()) return false;
            for (const auto& r : q.runs) {
                if (r.atomicObject) return false;
                for (char16_t c : r.text) {
                    if (c == u'\n' || c == u'\r') continue;
                    if (!isWhitespaceChar(c)) return false;
                }
            }

            for (const OwnedObject& oo : q.objects) {
                float l = 0, b = 0, r2 = 0, t = 0;
                if (!oo.object || !FPDFPageObj_GetBounds(oo.object, &l, &b, &r2, &t))
                    continue;
                if (r2 - l >= 0.3f && t - b >= 0.3f) return false;
            }
            return true;
        };
        state.paras.erase(
            std::remove_if(state.paras.begin(), state.paras.end(), blank),
            state.paras.end());
    }

    {
        auto invisibleOnly = [](const Paragraph& q) {
            if (q.runs.empty()) return false;
            for (const auto& r : q.runs) {
                if (r.atomicObject) return false;
                if (r.style.renderMode != 3) return false;
            }
            return true;
        };

        auto squash = [](const Paragraph& q) {
            std::string out;
            for (const auto& r : q.runs)
                for (char16_t c : r.text) {
                    if (c >= u'A' && c <= u'Z') out.push_back(static_cast<char>(c + 32));
                    else if ((c >= u'a' && c <= u'z') || (c >= u'0' && c <= u'9'))
                        out.push_back(static_cast<char>(c));
                }
            return out;
        };
        std::vector<size_t> drop;
        for (size_t i = 0; i < state.paras.size(); i++) {
            Paragraph& p = state.paras[i];
            if (!invisibleOnly(p)) continue;
            p.editable = false;
            p.lockReason = 4;
            p.invisible = true;
            const float area = std::max(1.0f, p.width * p.height);
            float covered = 0;
            std::string under;
            for (size_t j = 0; j < state.paras.size(); j++) {
                if (j == i) continue;
                const Paragraph& q = state.paras[j];
                if (invisibleOnly(q)) continue;
                const float ox = std::min(p.x + p.width, q.x + q.width) -
                                 std::max(p.x, q.x);
                const float oy = std::min(p.top, q.top) -
                                 std::max(p.top - p.height, q.top - q.height);
                if (ox <= 0 || oy <= 0) continue;
                covered += ox * oy;
                under += squash(q);
            }

            const std::string mine = squash(p);
            if (covered >= 0.5f * area ||
                (!mine.empty() && under.find(mine) != std::string::npos))
                drop.push_back(i);
        }
        for (auto it = drop.rbegin(); it != drop.rend(); ++it)
            state.paras.erase(state.paras.begin() + static_cast<long>(*it));
    }

    if (!tocBands.empty()) {
        auto inBand = [&](const Paragraph& q) {
            const float mid = q.top - q.height * 0.5f;
            for (const auto& t : tocBands)
                if (mid >= t.first && mid <= t.second) return true;
            return false;
        };
        int nextBlock = 0;
        for (const Paragraph& q : state.paras)
            nextBlock = std::max(nextBlock, q.blockId);

        if (nextBlock) {
            struct BlockBox { float x0, x1, yBot, yTop, rot; };
            std::map<int, BlockBox> bounds;
            for (const Paragraph& q : state.paras) {
                if (!q.blockId) continue;
                auto it = bounds.find(q.blockId);
                if (it == bounds.end()) {
                    bounds.emplace(q.blockId, BlockBox{q.x, q.x + q.width,
                                                       q.top - q.height, q.top,
                                                       q.rotation});
                } else {
                    it->second.x0 = std::min(it->second.x0, q.x);
                    it->second.x1 = std::max(it->second.x1, q.x + q.width);
                    it->second.yBot = std::min(it->second.yBot, q.top - q.height);
                    it->second.yTop = std::max(it->second.yTop, q.top);
                }
            }
            for (Paragraph& q : state.paras) {
                if (q.blockId || !q.editable || q.vertical) continue;
                if (!inBand(q)) continue;
                for (const auto& kv : bounds) {
                    const BlockBox& b = kv.second;
                    if (std::abs(q.rotation - b.rot) > 0.01f) continue;
                    if (q.x < b.x0 - 0.5f || q.x + q.width > b.x1 + 0.5f) continue;
                    if (q.top > b.yTop + 0.5f ||
                        q.top - q.height < b.yBot - 0.5f) continue;
                    q.blockId = kv.first;
                    break;
                }
            }

            for (int pass = 0; pass < 8; pass++) {
                bounds.clear();
                for (const Paragraph& q : state.paras) {
                    if (!q.blockId) continue;
                    auto it = bounds.find(q.blockId);
                    if (it == bounds.end()) {
                        bounds.emplace(q.blockId, BlockBox{q.x, q.x + q.width,
                                                           q.top - q.height,
                                                           q.top, q.rotation});
                    } else {
                        it->second.x0 = std::min(it->second.x0, q.x);
                        it->second.x1 = std::max(it->second.x1, q.x + q.width);
                        it->second.yBot =
                            std::min(it->second.yBot, q.top - q.height);
                        it->second.yTop = std::max(it->second.yTop, q.top);
                    }
                }
                if (bounds.empty()) break;
                std::set<int> dissolve;
                for (const Paragraph& q : state.paras) {

                    if (q.blockId || q.invisible) continue;
                    for (const auto& kv : bounds) {
                        const BlockBox& b = kv.second;
                        if (q.x < b.x0 - 0.5f || q.x + q.width > b.x1 + 0.5f)
                            continue;
                        if (q.top > b.yTop + 0.5f ||
                            q.top - q.height < b.yBot - 0.5f)
                            continue;
                        dissolve.insert(kv.first);
                    }
                }
                if (dissolve.empty()) break;
                for (Paragraph& q : state.paras)
                    if (dissolve.count(q.blockId)) q.blockId = 0;
            }
        }
    }

    return state;
}

static void appendFloat(std::string& out, float v) {
    char buf[40];
    snprintf(buf, sizeof(buf), "%.3f", static_cast<double>(v));
    out += buf;
}

std::string paragraphToJson(const Paragraph& p) {
    std::string j = "{";
    j += "\"id\":" + std::to_string(p.id);
    j += ",\"editable\":";
    j += p.editable ? "true" : "false";
    j += ",\"lockReason\":" + std::to_string(p.lockReason);

    if (p.blockId) j += ",\"blockId\":" + std::to_string(p.blockId);

    if (p.invisible) j += ",\"invisible\":true";

    if (p.sharesObjects) j += ",\"sharesObjects\":true";

    if (p.unwrapsForms) j += ",\"unwrapsForms\":true";
    j += ",\"box\":{\"x\":";
    appendFloat(j, p.x);
    j += ",\"top\":";
    appendFloat(j, p.top);
    j += ",\"w\":";
    appendFloat(j, p.width);
    j += ",\"h\":";
    appendFloat(j, p.height);
    j += "},\"rotation\":";
    appendFloat(j, p.rotation * 57.29577951308232f);
    j += ",\"marker\":";
    j += p.hasMarker ? "true" : "false";
    j += ",\"vertical\":";
    j += p.vertical ? "true" : "false";
    j += ",\"format\":{\"align\":" + std::to_string(p.fmt.align);
    j += ",\"lineSpacing\":";
    appendFloat(j, p.fmt.line_spacing);
    j += ",\"charSpacing\":";
    appendFloat(j, p.fmt.char_spacing);
    j += ",\"paraSpacing\":";
    appendFloat(j, p.fmt.para_spacing);
    j += ",\"wordSpacing\":";
    appendFloat(j, p.fmt.word_spacing);
    j += ",\"firstIndent\":";
    appendFloat(j, p.fmt.first_indent);
    j += ",\"hangIndent\":";
    appendFloat(j, p.fmt.hang_indent);
    j += ",\"dir\":" + std::to_string(p.fmt.dir);
    j += ",\"listLevel\":" + std::to_string(p.fmt.list_level);
    j += "},\"firstBaseline\":";
    appendFloat(j, p.firstBaseline);
    j += ",\"lines\":[";
    for (size_t i = 0; i < p.lines.size(); i++) {
        if (i) j += ",";
        j += "{\"y\":";
        appendFloat(j, p.lines[i].baseline);
        j += ",\"x\":";
        appendFloat(j, p.lines[i].x);
        j += ",\"w\":";
        appendFloat(j, p.lines[i].w);
        j += ",\"off\":" + std::to_string(p.lines[i].off);
        if (p.lines[i].hasPenX) {
            j += ",\"px\":";
            appendFloat(j, p.lines[i].penX);
        }
        j += "}";
    }
    j += "],\"runs\":[";
    for (size_t i = 0; i < p.runs.size(); i++) {
        const ParaRun& r = p.runs[i];
        if (i) j += ",";
        j += "{\"text\":\"";
        jsonEscapeInto(j, utf16ToUtf8(r.text));
        j += "\",\"family\":\"";
        jsonEscapeInto(j, r.style.family);
        j += "\",\"bold\":";
        j += r.style.bold ? "true" : r.style.fauxBold ? "2" : "false";
        j += ",\"italic\":";
        j += r.style.italic ? "true" : r.style.fauxItalic ? "2" : "false";
        j += ",\"size\":";
        appendFloat(j, r.style.size);
        j += ",\"rgba\":" + std::to_string(r.style.rgba);
        j += ",\"underline\":";
        j += r.style.underline ? "true" : "false";
        j += ",\"strike\":";
        j += r.style.strike ? "true" : "false";
        j += ",\"script\":" + std::to_string(r.style.script);
        j += ",\"renderMode\":" + std::to_string(r.style.renderMode);

        if (r.boundFont && r.originalFont)
            j += std::string(",\"boundOriginal\":") +
                 (r.boundFont == r.originalFont ? "true" : "false");
        j += ",\"strokeRgba\":" + std::to_string(r.style.strokeRgba);
        j += ",\"strokeWidth\":";
        appendFloat(j, r.style.strokeWidth);
        j += ",\"hScale\":";
        appendFloat(j, r.style.hScale);
        j += ",\"rise\":";
        appendFloat(j, r.style.rise);

        j += ",\"fallback\":\"";
        j += fontLooksMono(r.originalFont, r.style.family) ? "mono"
             : fontLooksSerif(r.originalFont, r.style.family) ? "serif" : "sans";
        j += "\"";

        if (r.originalFont && fontIsSubset(r.originalFont)) j += ",\"subset\":true";

        if (r.atomicObject) {
            j += ",\"atomic\":true,\"box\":[";
            appendFloat(j, r.atomicX);
            j += ",";
            appendFloat(j, r.atomicTop);
            j += ",";
            appendFloat(j, r.atomicW);
            j += ",";
            appendFloat(j, r.atomicH);
            j += ",";
            appendFloat(j, r.atomicBaseline);
            j += "],\"obj\":";
            j += std::to_string(reinterpret_cast<uintptr_t>(r.atomicObject));
        }
        j += "}";
    }
    j += "]}";
    return j;
}

}


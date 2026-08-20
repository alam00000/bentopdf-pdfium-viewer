#include <deque>

#include "ec_internal.h"
#include "fpdf_structtree.h"
#include "fpdf_transformpage.h"
#include "pdfium_internal.h"

namespace ec {

namespace {

uint32_t probeCharcode(FPDF_DOCUMENT doc, FPDF_FONT font, char16_t ch) {
    if (!doc || !font) return 0;
    FPDF_PAGEOBJECT probe = FPDFPageObj_CreateTextObj(doc, font, 12.0f);
    if (!probe) return 0;
    unsigned short one[2] = {static_cast<unsigned short>(ch), 0};
    uint32_t code = 0;
    if (FPDFText_SetText(probe, one)) {
        const std::vector<uint32_t> got = readOrigCharcodes(probe);
        if (got.size() == 1) code = got[0];
    }
    FPDFPageObj_Destroy(probe);
    return code;
}

void pinLiftedTextPositions(FPDF_PAGEOBJECT obj) {
    if (FPDFPageObj_GetType(obj) != FPDF_PAGEOBJ_TEXT) return;
    const std::vector<OrigGlyph> g = readOrigGlyphs(obj);
    if (g.empty()) return;
    for (const OrigGlyph& og : g)
        if (og.y != 0) return;
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    if (!FPDFPageObj_GetMatrix(obj, &m)) return;
    const float base = g.front().x;

    std::vector<float> pos;
    pos.reserve(g.size() > 1 ? g.size() - 1 : 0);
    for (size_t i = 1; i < g.size(); i++) pos.push_back(g[i].x - base);
    if (!pos.empty() &&
        !FPDFText_SetPositions(obj, pos.data(),
                               static_cast<unsigned long>(pos.size())))
        return;
    if (base != 0) {
        m.e += base * m.a;
        m.f += base * m.b;
        FPDFPageObj_SetMatrix(obj, &m);
    }
}

constexpr float kSuperScale = 0.58f;
constexpr float kSuperShift = 0.34f;
constexpr float kSubShift = -0.18f;

struct ResolvedRun {
    const ParaRun* run = nullptr;
    FPDF_FONT font = nullptr;
    float emitSize = 12;
    float baseShift = 0;
    float hScale = 1;

    bool complex = false;
    const std::vector<uint8_t>* hbBytes = nullptr;
    FPDF_FONT cidFont = nullptr;
};

struct Token {
    enum Kind { Word, Space, Break, ParaBreak } kind = Word;

    std::vector<std::pair<uint32_t, int>> chars;

    std::vector<float> advs;

    std::vector<size_t> offs;

    uint8_t level = 0;
    int runIndex = 0;
    size_t off = 0;
    float width = 0;

    bool softHyphen = false;
};

void appendCodepointUtf16(std::u16string& out, uint32_t cp) {
    if (cp <= 0xFFFF) {
        out.push_back(static_cast<char16_t>(cp));
    } else {
        uint32_t v = cp - 0x10000;
        out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
        out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
    }
}

bool isBreakableSpace(uint32_t cp) {
    return cp == u' ' || cp == u'\t' || cp == 0x3000;
}

bool fontCovers(FPDF_FONT font, const std::vector<uint32_t>& cps) {
    if (!font) return false;

    float notdefW = -1;
    for (uint32_t sentinel : {0xF8FFu, 0x10FFFDu}) {
        float w = 0;
        if (FPDFFont_GetGlyphWidth(font, sentinel, 12.0f, &w)) { notdefW = w; break; }
    }
    for (uint32_t cp : cps) {
        if (cp == u'\n' || cp == u'\r') continue;
        float w = 0;
        if (!FPDFFont_GetGlyphWidth(font, cp, 12.0f, &w)) return false;
        if (w <= 0.001f && cp != u' ' && cp != 0x00A0) return false;

        if (notdefW >= 0 && std::abs(w - notdefW) < 0.01f && cp != u' ' && cp != 0x00A0) {
            FPDF_GLYPHPATH gp = FPDFFont_GetGlyphPath(font, cp, 12.0f);
            if (!gp || FPDFGlyphPath_CountGlyphSegments(gp) <= 0) return false;
        }
    }
    return true;
}

std::string standardFontFor(const RunStyle& st) {

    std::string fam = st.family;
    for (auto& c : fam) c = static_cast<char>(tolower(c));
    bool serif = fam.find("times") != std::string::npos ||
                 fam.find("georgia") != std::string::npos ||
                 fam.find("serif") != std::string::npos;
    bool fixed = fam.find("courier") != std::string::npos ||
                 fam.find("mono") != std::string::npos;
    const char* base = fixed ? "Courier" : (serif ? "Times" : "Helvetica");
    std::string name = base;
    if (fixed) {
        if (st.bold && st.italic) name += "-BoldOblique";
        else if (st.bold) name += "-Bold";
        else if (st.italic) name += "-Oblique";
    } else if (serif) {
        if (st.bold && st.italic) name += "-BoldItalic";
        else if (st.bold) name += "-Bold";
        else if (st.italic) name += "-Italic";
        else name += "-Roman";
    } else {
        if (st.bold && st.italic) name += "-BoldOblique";
        else if (st.bold) name += "-Bold";
        else if (st.italic) name += "-Oblique";
    }
    return name;
}

float glyphAdvance(FPDF_FONT font, uint32_t cp, float size) {
    float w = 0;
    if (font && FPDFFont_GetGlyphWidth(font, cp, size, &w) && w > 0) return w;
    return size * 0.5f;
}

float fontAscent(FPDF_FONT font, float size) {
    float a = 0;
    if (font && FPDFFont_GetAscent(font, size, &a) && a > 0) return a;
    return size * 0.78f;
}

float fontDescent(FPDF_FONT font, float size) {
    float d = 0;
    if (font && FPDFFont_GetDescent(font, size, &d)) return std::abs(d);
    return size * 0.22f;
}

}

const std::vector<uint8_t>* fontBytesFor(Session& s, FPDF_FONT f) {
    if (!f) return nullptr;
    auto it = s.fontBytes.find(f);
    if (it != s.fontBytes.end()) return it->second.empty() ? nullptr : &it->second;
    auto& v = s.fontBytes[f];
    size_t n = 0;
    if (FPDFFont_GetFontData(f, nullptr, 0, &n) && n > 0) {
        v.resize(n);
        size_t m = 0;
        if (!FPDFFont_GetFontData(f, v.data(), v.size(), &m) || m != n) v.clear();
    }
    return v.empty() ? nullptr : &v;
}

bool fontCovers(Session& s, FPDF_FONT font, const std::vector<uint32_t>& cps) {
    if (!font) return false;

    const std::set<uint32_t>* rendered = nullptr;
    {
        auto it = s.fontRenderedCps.find(font);
        if (it != s.fontRenderedCps.end()) rendered = &it->second;
    }
    const std::vector<uint8_t>* bytes = fontBytesFor(s, font);
    std::vector<uint32_t> unproven;
    for (uint32_t cp : cps) {
        if (cp == u'\n' || cp == u'\r' || cp == u' ' || cp == 0x00A0) continue;
        if (rendered && rendered->count(cp)) continue;
        unproven.push_back(cp);
    }
    if (unproven.empty()) return true;
    if (bytes) {
        for (uint32_t cp : unproven) {
            if (!hbFontHasGlyph(bytes->data(), bytes->size(), cp)) return false;
        }
        return true;
    }
    return fontCovers(font, unproven);
}

bool fontIsSubset(FPDF_FONT font) {
    if (!font) return false;
    char buf[256] = {0};
    size_t n = FPDFFont_GetBaseFontName(font, buf, sizeof(buf));
    if (n < 8 || buf[6] != '+') return false;
    for (int i = 0; i < 6; i++) {
        if (buf[i] < 'A' || buf[i] > 'Z') return false;
    }
    return true;
}

std::string fontStyleKey(const std::string& family, bool bold, bool italic) {
    std::string k = family;
    for (auto& c : k) c = static_cast<char>(tolower(c));
    k += "|";
    k += bold ? "1" : "0";
    k += italic ? "1" : "0";
    return k;
}

void registerDocFont(Session& s, FPDF_FONT font, const RunStyle& style) {
    if (!font || style.family.empty()) return;
    auto& v = s.docFontsByStyle[fontStyleKey(style.family, style.bold, style.italic)];
    if (std::find(v.begin(), v.end(), font) != v.end()) return;
    if (fontIsSubset(font)) v.push_back(font);
    else v.insert(v.begin(), font);
}

bool fontLooksMono(FPDF_FONT font, const std::string& family) {
    std::string famLower = family;
    for (auto& c : famLower) c = static_cast<char>(tolower(c));
    return famLower.find("courier") != std::string::npos ||
           famLower.find("mono") != std::string::npos ||
           (font && (FPDFFont_GetFlags(font) & 1));
}

bool fontLooksSerif(FPDF_FONT font, const std::string& family) {
    std::string famLower = family;
    for (auto& c : famLower) c = static_cast<char>(tolower(c));

    static const char* kSansNames[] = {"sans", "grotesk", "grotesque", "gothic"};
    for (const char* n : kSansNames) {
        if (famLower.find(n) != std::string::npos) return false;
    }
    static const char* kSerifNames[] = {
        "times", "serif", "georgia", "garamond", "book", "roman",
        "palatino", "century", "schoolbook", "caslon", "baskerville",
        "minion", "charter", "cambria", "constantia", "didot",
        "bodoni", "utopia", "gentium", "cmr", "computer modern"};
    for (const char* n : kSerifNames) {
        if (famLower.find(n) != std::string::npos) return true;
    }
    if (font) {

        FPDF_GLYPHPATH gp = FPDFFont_GetGlyphPath(font, u'l', 12.0f);
        if (gp) {
            const int nseg = FPDFGlyphPath_CountGlyphSegments(gp);
            if (nseg > 0) return nseg >= 9;
        }

        int flags = FPDFFont_GetFlags(font);
        if (flags > 0 && (flags & (1 << 1))) return true;
    }
    return false;
}

static bool fontAllowsEditableEmbed(const unsigned char* d, unsigned long n) {
    auto u16 = [&](unsigned long off) -> uint32_t {
        return (static_cast<uint32_t>(d[off]) << 8) | d[off + 1];
    };
    if (!d || n < 12) return true;
    const uint32_t tag = (static_cast<uint32_t>(d[0]) << 24) |
                         (static_cast<uint32_t>(d[1]) << 16) |
                         (static_cast<uint32_t>(d[2]) << 8) | d[3];
    if (tag != 0x00010000 && tag != 0x4F54544F   &&
        tag != 0x74727565  ) {
        return true;
    }
    const uint32_t numTables = u16(4);
    if (numTables > 512 || 12 + 16ul * numTables > n) return true;
    for (uint32_t i = 0; i < numTables; i++) {
        const unsigned long rec = 12 + 16ul * i;
        if (d[rec] == 'O' && d[rec + 1] == 'S' && d[rec + 2] == '/' &&
            d[rec + 3] == '2') {
            const uint32_t off = (static_cast<uint32_t>(d[rec + 8]) << 24) |
                                 (static_cast<uint32_t>(d[rec + 9]) << 16) |
                                 (static_cast<uint32_t>(d[rec + 10]) << 8) |
                                 d[rec + 11];
            if (off + 10ul > n) return true;
            const uint32_t fsType = u16(off + 8);
            return (fsType & 0x0008) || !(fsType & 0x0006);
        }
    }
    return true;
}

bool isWinAnsiHighPunct(uint32_t cp) {
    switch (cp) {
        case 0x0152: case 0x0153:
        case 0x0160: case 0x0161:
        case 0x0178:
        case 0x017D: case 0x017E:
        case 0x0192:
        case 0x02C6: case 0x02DC:
        case 0x2013: case 0x2014:
        case 0x2018: case 0x2019: case 0x201A:
        case 0x201C: case 0x201D: case 0x201E:
        case 0x2020: case 0x2021: case 0x2022:
        case 0x2026: case 0x2030:
        case 0x2039: case 0x203A:
        case 0x20AC:
        case 0x2122:
            return true;
        default:
            return false;
    }
}

FPDF_FONT resolveFont(Session& s, const RunStyle& style, FPDF_FONT preferred,
                      const std::vector<uint32_t>& codepoints,
                      bool allowSubsetReuse, FPDF_FONT scriptFallback,
                      FPDF_FONT avoid) {

    if (preferred && allowSubsetReuse) return preferred;
    if (preferred && !fontIsSubset(preferred) &&
        fontCovers(s, preferred, codepoints)) {
        return preferred;
    }

    const std::string key = fontStyleKey(style.family, style.bold, style.italic);
    auto it = s.fontCache.find(key);
    if (it != s.fontCache.end() && fontCovers(s, it->second, codepoints)) return it->second;

    if (!avoid) {
        auto dit = s.docFontsByStyle.find(key);
        if (dit != s.docFontsByStyle.end()) {
            for (FPDF_FONT f : dit->second) {
                if (f == preferred) continue;
                if (!fontCovers(s, f, codepoints)) continue;

                return f;
            }
        }
    }

    if (avoid && fontCovers(s, avoid, codepoints)) {
        uint32_t cph = 2166136261u;
        for (uint32_t cp : codepoints) {
            cph ^= cp;
            cph *= 16777619u;
        }
        char okey[48];
        snprintf(okey, sizeof(okey), "orig:%p:%08x",
                 static_cast<void*>(avoid), cph);
        auto oit = s.fontCache.find(okey);
        if (oit != s.fontCache.end() &&
            fontCovers(s, oit->second, codepoints))
            return oit->second;
        std::set<uint32_t> want(codepoints.begin(), codepoints.end());
        want.insert(u' ');
        bool dis = false;
        std::vector<uint8_t> bytes =
            synthesizeSfnt(avoid, want, nullptr, &dis, false,
                           "ECO" + style.family);
        if (!dis && !bytes.empty() &&
            fontAllowsEditableEmbed(bytes.data(), bytes.size())) {
            FPDF_FONT f = FPDFText_LoadFont(
                s.doc, bytes.data(), static_cast<unsigned int>(bytes.size()),
                FPDF_FONT_TRUETYPE, 1);
            if (f) {
                s.fontBytes[f].assign(bytes.begin(), bytes.end());
                if (fontCovers(s, f, codepoints)) {
                    s.fontCache[okey] = f;
                    return f;
                }
            }
        }
    }

    RunStyle hinted = style;
    if (fontLooksMono(preferred, style.family)) hinted.family += " mono";
    else if (fontLooksSerif(preferred, style.family)) hinted.family += " serif";

    if (s.provider) {
        std::vector<unsigned int> cps(codepoints.begin(), codepoints.end());
        unsigned char* data = nullptr;
        unsigned long size = 0;
        if (s.provider(s.providerCtx, hinted.family.c_str(), style.bold ? 1 : 0,
                       style.italic ? 1 : 0, cps.data(), static_cast<int>(cps.size()),
                       &data, &size) &&
            data && size > 0) {

            const unsigned char* embedData = data;
            unsigned long embedSize = size;
            std::vector<uint8_t> standalone;
            if (size > 4 && data[0] == 't' && data[1] == 't' && data[2] == 'c' &&
                data[3] == 'f') {
                const unsigned idx =
                    hbPickFace(data, size, style.family, style.bold, style.italic);
                standalone = hbExtractFace(data, size, idx);
                if (!standalone.empty()) {
                    embedData = standalone.data();
                    embedSize = standalone.size();
                }
            }

            const bool isCff = embedSize > 4 && embedData[0] == 'O' &&
                               embedData[1] == 'T' && embedData[2] == 'T' &&
                               embedData[3] == 'O';
            FPDF_FONT f = fontAllowsEditableEmbed(embedData, embedSize)
                              ? FPDFText_LoadFont(
                                    s.doc, embedData,
                                    static_cast<unsigned int>(embedSize),
                                    isCff ? FPDF_FONT_TYPE1 : FPDF_FONT_TRUETYPE,
                                    1)
                              : nullptr;
            if (f) s.fontBytes[f].assign(embedData, embedData + embedSize);
            free(data);
            if (f) {
                s.fontCache[key] = f;
                s.providerFonts.insert(f);

                if (fontCovers(s, f, codepoints)) return f;
            }
        } else if (data) {
            free(data);
        }
    }

    bool nonLatin = false;
    for (uint32_t cp : codepoints) {
        if (cp >= 0x0370 && !isWinAnsiHighPunct(cp)) { nonLatin = true; break; }
    }
    auto cached = s.fontCache.find(key);
    if (nonLatin) {
        if (preferred) return preferred;
        if (cached != s.fontCache.end()) return cached->second;
        if (scriptFallback) return scriptFallback;
    }

    if (cached != s.fontCache.end()) {

        bool any = false;
        for (uint32_t cp : codepoints) {
            if (cp == u' ' || cp == 0x00A0) continue;
            if (fontCovers(s, cached->second, {cp})) { any = true; break; }
        }
        if (any) return cached->second;
    }

    const std::string stdName = standardFontFor(hinted);
    FPDF_FONT std14 = FPDFText_LoadStandardFont(s.doc, stdName.c_str());

    if (std14) {
        bool collides = false;
        for (const auto& kv : s.docFontsByStyle) {
            for (FPDF_FONT f2 : kv.second) {
                char buf[128] = {0};
                if (FPDFFont_GetBaseFontName(f2, buf, sizeof(buf)) <= 1)
                    continue;
                std::string bn(buf);
                if (bn.size() > 7 && bn[6] == '+') bn = bn.substr(7);
                if (bn == stdName) { collides = true; break; }
            }
            if (collides) break;
        }
        if (collides) {
            std::set<uint32_t> want(codepoints.begin(), codepoints.end());
            for (uint32_t c = 0x20; c < 0x7F; c++) want.insert(c);
            bool dis = false;
            std::vector<uint8_t> bytes = synthesizeSfnt(
                std14, want, nullptr, &dis,  false,
                 "EC" + stdName);
            if (!dis && !bytes.empty() &&
                fontAllowsEditableEmbed(bytes.data(), bytes.size())) {
                FPDF_FONT f = FPDFText_LoadFont(
                    s.doc, bytes.data(),
                    static_cast<unsigned int>(bytes.size()),
                    FPDF_FONT_TRUETYPE, 1);
                if (f) {
                    s.fontBytes[f].assign(bytes.begin(), bytes.end());
                    if (fontCovers(s, f, codepoints)) {
                        s.fontCache[key] = f;
                        return f;
                    }
                }
            }
        }
        s.fontCache[key] = std14;
    }
    return std14;
}

bool objectStillOnPage(FPDF_PAGE page, FPDF_PAGEOBJECT obj) {
    if (!page || !obj) return false;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (o == obj) return true;
        if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_FORM) continue;
        const int kids = FPDFFormObj_CountObjects(o);
        for (int k = 0; k < kids; k++)
            if (FPDFFormObj_GetObject(o, static_cast<unsigned long>(k)) == obj)
                return true;
    }
    return false;
}

void purgeDeadObjectHandles(FPDF_PAGE page, Paragraph& p) {
    if (!page) return;

    std::set<FPDF_PAGEOBJECT> live;

    std::function<void(FPDF_PAGEOBJECT, int)> mark = [&](FPDF_PAGEOBJECT o,
                                                         int depth) {
        if (!o || depth > 4) return;
        live.insert(o);
        if (FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_FORM) return;
        const int kids = FPDFFormObj_CountObjects(o);
        for (int k = 0; k < kids; k++)
            mark(FPDFFormObj_GetObject(o, static_cast<unsigned long>(k)),
                 depth + 1);
    };
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) mark(FPDFPage_GetObject(page, i), 0);
    p.objects.erase(std::remove_if(p.objects.begin(), p.objects.end(),
                                   [&](const OwnedObject& oo) {
                                       return oo.object && !live.count(oo.object);
                                   }),
                    p.objects.end());
    p.flattenForms.erase(
        std::remove_if(p.flattenForms.begin(), p.flattenForms.end(),
                       [&](FPDF_PAGEOBJECT f) { return f && !live.count(f); }),
        p.flattenForms.end());
    for (auto ef = p.explodeForms.begin(); ef != p.explodeForms.end();) {
        ef = (*ef && !live.count(*ef)) ? p.explodeForms.erase(ef)
                                       : std::next(ef);
    }

    for (OwnedObject& oo : p.objects)
        if (oo.container && !live.count(oo.container)) oo.container = nullptr;
    for (ParaRun& r : p.runs) {
        if (r.atomicObject && !live.count(r.atomicObject)) r.atomicObject = nullptr;
        if (r.atomicContainer && !live.count(r.atomicContainer))
            r.atomicContainer = nullptr;
    }
}

bool layoutParagraph(Session& s, FPDF_PAGE page, Paragraph& p, bool autoWiden,
                     std::string* previewJson) {

    if (!previewJson) purgeDeadObjectHandles(page, p);

    if (!previewJson) dealiasPageFonts(s, page, &p);

    const bool fragilePage = s.fontsFragile.count(page) > 0;

    float cropX2 = 0, cropY2 = 0;
    int pageRot2 = 0;
    float unrotW2 = 0, unrotH2 = 0;
    {
        auto itc = s.pages.find(page);
        if (itc != s.pages.end()) {
            cropX2 = itc->second.cropX;
            cropY2 = itc->second.cropY;
            pageRot2 = itc->second.pageRot;
            unrotW2 = itc->second.unrotW;
            unrotH2 = itc->second.unrotH;
        }
    }
    if (getenv("EC_LAYOUT_DEBUG")) {
        std::string t8;
        for (const auto& r0 : p.runs)
            for (char16_t c : r0.text) { if (t8.size() > 24) break; t8 += c < 128 ? (char)c : '?'; }
        fprintf(stderr, "[layout] para %d pageRot=%d objs=%zu runs=%zu \"%s\"\n",
                p.id, pageRot2, p.objects.size(), p.runs.size(), t8.c_str());
    }

    const float pageRad2 = static_cast<float>(pageRot2) * 3.14159265358979f / 180.0f;
    const float prC = std::cos(pageRad2), prS = std::sin(pageRad2);
    float backX = cropX2, backY = cropY2;
    switch (((pageRot2 % 360) + 360) % 360) {
        case 90:  backX += unrotW2; break;
        case 180: backX += unrotW2; backY += unrotH2; break;
        case 270: backY += unrotH2; break;
        default: break;
    }

    int insertIdx = -1;
    {

        std::set<FPDF_PAGEOBJECT> mine(p.flattenForms.begin(),
                                       p.flattenForms.end());
        for (const OwnedObject& oo : p.objects) {
            if (!oo.container) mine.insert(oo.object);
        }
        const int n = FPDFPage_CountObjects(page);
        for (int i = 0; i < n && insertIdx < 0; i++) {
            if (mine.count(FPDFPage_GetObject(page, i))) insertIdx = i;
        }
    }
    std::vector<OwnedObject> preservedObjects;

    std::set<FPDF_PAGEOBJECT> preservedHandles;
    for (const OwnedObject& oo : p.objects)
        if (oo.preserved && oo.object) preservedHandles.insert(oo.object);
    std::set<FPDF_PAGEOBJECT> handled;
    for (const OwnedObject& oo : p.objects) {
        if (oo.object && !handled.insert(oo.object).second) continue;
        if (oo.preserved) {

            preservedObjects.push_back(oo);
            continue;
        }
        if (oo.object && preservedHandles.count(oo.object)) {
            preservedObjects.push_back(oo);
            continue;
        }
        historyRemoveObject(s, page, oo.container, oo.object);
    }

    const std::vector<FPDF_PAGEOBJECT> noForms;
    for (FPDF_PAGEOBJECT form : (previewJson ? noForms : p.flattenForms)) {

        int at = -1;
        {
            const int n = FPDFPage_CountObjects(page);
            for (int i = 0; i < n && at < 0; i++)
                if (FPDFPage_GetObject(page, i) == form) at = i;
        }
        if (at < 0) continue;

        std::function<void(FPDF_PAGEOBJECT, const FS_MATRIX&, bool)> liftKids =
            [&](FPDF_PAGEOBJECT holder, const FS_MATRIX& fm, bool haveM) {
                std::vector<FPDF_PAGEOBJECT> keep;
                const int kids = FPDFFormObj_CountObjects(holder);
                for (int i = 0; i < kids; i++) {
                    FPDF_PAGEOBJECT kid = FPDFFormObj_GetObject(
                        holder, static_cast<unsigned long>(i));
                    if (!kid) continue;

                    bool ours = false;
                    for (const OwnedObject& oo : p.objects)
                        if (oo.object == kid) { ours = !oo.preserved; break; }
                    if (!ours) keep.push_back(kid);
                }
                for (FPDF_PAGEOBJECT kid : keep) {
                    if (FPDFPageObj_GetType(kid) == FPDF_PAGEOBJ_FORM &&
                        p.explodeForms.count(kid)) {
                        FS_MATRIX km{1, 0, 0, 1, 0, 0};
                        FS_MATRIX composed = fm;
                        bool haveK = FPDFPageObj_GetMatrix(kid, &km) != 0;
                        if (haveK && haveM) {
                            composed.a = km.a * fm.a + km.b * fm.c;
                            composed.b = km.a * fm.b + km.b * fm.d;
                            composed.c = km.c * fm.a + km.d * fm.c;
                            composed.d = km.c * fm.b + km.d * fm.d;
                            composed.e = km.e * fm.a + km.f * fm.c + fm.e;
                            composed.f = km.e * fm.b + km.f * fm.d + fm.f;
                        } else if (haveK) {
                            composed = km;
                        }
                        liftKids(kid, composed, haveK || haveM);
                        if (FPDFFormObj_RemoveObject(holder, kid))
                            FPDFPageObj_Destroy(kid);
                        continue;
                    }
                    if (!FPDFFormObj_RemoveObject(holder, kid)) continue;
                    if (haveM) {
                        FPDFPageObj_TransformClipPath(kid, fm.a, fm.b, fm.c,
                                                      fm.d, fm.e, fm.f);
                        FPDFPageObj_TransformF(kid, &fm);
                    }

                    pinLiftedTextPositions(kid);
                    historyInsertObject(s, page, kid, at >= 0 ? at++ : -1);

                    for (OwnedObject& oo : preservedObjects)
                        if (oo.object == kid) oo.container = nullptr;
                    for (ParaRun& r : p.runs)
                        if (r.atomicObject == kid) r.atomicContainer = nullptr;
                }
            };
        FS_MATRIX fm{1, 0, 0, 1, 0, 0};
        const bool haveM = FPDFPageObj_GetMatrix(form, &fm) != 0;
        liftKids(form, fm, haveM);
        historyRemoveObject(s, page, nullptr, form);

        if (at >= 0) insertIdx = at;

        auto itp = s.pages.find(page);
        if (itp != s.pages.end()) {
            auto dead = [&](FPDF_PAGEOBJECT f) {
                return f == form || (f && p.explodeForms.count(f));
            };
            for (Paragraph& q : itp->second.paras) {
                for (OwnedObject& oo : q.objects)
                    if (dead(oo.container)) oo.container = nullptr;
                for (ParaRun& r : q.runs)
                    if (dead(r.atomicContainer)) r.atomicContainer = nullptr;
                q.flattenForms.erase(
                    std::remove_if(q.flattenForms.begin(), q.flattenForms.end(),
                                   dead),
                    q.flattenForms.end());
                for (auto ef = q.explodeForms.begin();
                     ef != q.explodeForms.end();) {
                    ef = dead(*ef) ? q.explodeForms.erase(ef) : std::next(ef);
                }
            }
        }
    }
    p.flattenForms.clear();
    p.explodeForms.clear();
    p.objects = std::move(preservedObjects);
    const size_t preEditLineCount = p.lines.size();
    p.lines.clear();

    std::vector<ParaRun> runs;
    for (auto& r : p.runs) {
        if (!r.text.empty()) runs.push_back(r);
    }
    p.runs = runs;
    if (p.runs.empty()) {
        p.height = 0;
        return true;
    }

    if (p.vertical) {
        struct VRun {
            const ParaRun* run;
            FPDF_FONT font;
        };
        std::vector<VRun> vruns;
        for (auto& r : p.runs) {
            std::vector<uint32_t> cps;
            std::set<uint32_t> seen;
            for (size_t ci = 0; ci < r.text.size(); ci++) {
                uint32_t cp = r.text[ci];
                if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < r.text.size() &&
                    r.text[ci + 1] >= 0xDC00 && r.text[ci + 1] <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) +
                         (r.text[ci + 1] - 0xDC00);
                    ci++;
                }
                if (cp == u'\n' || cp == u'\r' || cp == u' ') continue;
                if (seen.insert(cp).second) cps.push_back(cp);
            }
            FPDF_FONT f = resolveFont(s, r.style,
                                      fragilePage ? nullptr : r.originalFont,
                                      cps, !fragilePage && r.textUnchanged,
                                      r.scriptFallbackFont,
                                      fragilePage ? r.originalFont : nullptr);
            if (!f) return false;
            vruns.push_back({&r, f});
        }
        const float size0 = p.runs.front().style.size;
        const float pitch =
            std::max(0.6f, std::min(3.0f, p.fmt.line_spacing)) * size0;
        const float topY = p.top - size0;
        float colX = p.x + p.width - size0;
        float y = topY;
        bool colUsed = false;
        auto newColumn = [&]() {
            if (colUsed) {
                p.lines.push_back({topY, colX, size0});
                colX -= pitch;
                y = topY;
                colUsed = false;
            }
        };
        int emitted = 0;
        for (auto& vr : vruns) {
            const ParaRun& r = *vr.run;
            const RunStyle& st = r.style;
            for (size_t ci = 0; ci < r.text.size(); ci++) {
                uint32_t cp = r.text[ci];
                if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < r.text.size() &&
                    r.text[ci + 1] >= 0xDC00 && r.text[ci + 1] <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) +
                         (r.text[ci + 1] - 0xDC00);
                    ci++;
                }
                if (cp == u'\r') continue;
                if (cp == u'\n') {
                    newColumn();
                    continue;
                }
                if (isBreakableSpace(cp)) {
                    y -= st.size * (cp == 0x3000 ? 1.0f : 0.5f);
                    continue;
                }
                if (colUsed && y < p.top - p.height + 0.25f * st.size) {
                    newColumn();
                }
                FPDF_PAGEOBJECT obj =
                    FPDFPageObj_CreateTextObj(s.doc, vr.font, st.size);
                if (!obj) continue;
                unsigned short wide[3] = {0, 0, 0};
                if (cp <= 0xFFFF) {
                    wide[0] = static_cast<unsigned short>(cp);
                } else {
                    wide[0] = static_cast<unsigned short>(
                        0xD800 + ((cp - 0x10000) >> 10));
                    wide[1] = static_cast<unsigned short>(
                        0xDC00 + ((cp - 0x10000) & 0x3FF));
                }
                if (!FPDFText_SetText(obj, wide)) {
                    FPDFPageObj_Destroy(obj);
                    continue;
                }
                FS_MATRIX m{prC, prS, -prS, prC,
                            prC * colX - prS * y + backX,
                            prS * colX + prC * y + backY};
                FPDFPageObj_SetMatrix(obj, &m);
                FPDFPageObj_SetFillColor(obj, (st.rgba >> 24) & 0xFF,
                                         (st.rgba >> 16) & 0xFF,
                                         (st.rgba >> 8) & 0xFF, st.rgba & 0xFF);
                historyInsertObject(s, page, obj, insertIdx >= 0 ? insertIdx++ : -1);
                p.objects.push_back({obj, nullptr});
                emitted++;
                colUsed = true;
                y -= st.size;
            }
        }
        newColumn();

        const float rightEdge = p.x + p.width;
        const float leftUsed = colX + pitch - size0 * 0.0f;
        if (!p.lines.empty()) {
            const float newLeft = std::min(p.x, p.lines.back().x);
            p.width = rightEdge - newLeft;
            p.x = newLeft;
        }
        p.firstBaseline = topY;
        return emitted > 0 || p.runs.empty();
    }

    bool paraRtl = false;
    {
        std::u16string all;
        for (const auto& r : p.runs) all += r.text;
        paraRtl = p.fmt.dir == 2   ? true
                  : p.fmt.dir == 1 ? false
                                   : textIsRtl(all);
    }
    for (size_t i = 0; i < p.runs.size(); i++) {
        p.runs[i].layoutSrc = static_cast<int>(i);
        p.runs[i].boundFont = nullptr;
    }
    std::vector<ParaRun> shaped;
    if (paraRtl) shaped = p.runs;
    std::vector<ParaRun>& layoutRuns = paraRtl ? shaped : p.runs;

    for (size_t i = 0; i < layoutRuns.size(); i++) {
        const ParaRun r0 = layoutRuns[i];
        if (!r0.originalFont || r0.textUnchanged || fontIsSubset(r0.originalFont))
            continue;
        const std::u16string& t = r0.text;
        if (t.size() < 3) continue;

        std::vector<size_t> starts;
        std::vector<int> cov;
        std::vector<uint32_t> allCps;
        for (size_t k = 0; k < t.size();) {
            uint32_t cp = t[k];
            size_t l = 1;
            if (cp >= 0xD800 && cp <= 0xDBFF && k + 1 < t.size() &&
                t[k + 1] >= 0xDC00 && t[k + 1] <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (t[k + 1] - 0xDC00);
                l = 2;
            }
            starts.push_back(k);
            if (cp == u'\n' || cp == u'\r' || cp == u' ' || cp == 0x00A0) {
                cov.push_back(-1);
            } else {
                uint32_t probeCp = cp == 0x00AD ? u'-' : cp;
                std::vector<uint32_t> one{probeCp};
                cov.push_back(fontCovers(s, r0.originalFont, one) ? 1 : 0);
                allCps.push_back(probeCp);
            }
            k += l;
        }
        starts.push_back(t.size());
        std::vector<uint32_t> clusterCps;
        {
            size_t ci = 0;
            for (size_t k = 0; k < t.size();) {
                uint32_t cp = t[k];
                size_t l = 1;
                if (cp >= 0xD800 && cp <= 0xDBFF && k + 1 < t.size() &&
                    t[k + 1] >= 0xDC00 && t[k + 1] <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (t[k + 1] - 0xDC00);
                    l = 2;
                }
                clusterCps.push_back(cp);
                k += l;
                ci++;
            }
        }

        auto isWordCp = [](uint32_t cp) {
            return (cp >= u'0' && cp <= u'9') || (cp >= u'A' && cp <= u'Z') ||
                   (cp >= u'a' && cp <= u'z') || cp >= 0x00C0;
        };

        long lo = -1, hi = -1;
        int covered = 0;
        for (size_t k = 0; k < cov.size(); k++) {
            if (cov[k] == 0) { if (lo < 0) lo = (long)k; hi = (long)k; }
            if (cov[k] == 1) covered++;
        }
        if (lo < 0 || !covered) continue;

        bool atEnd = true, atStart = true;
        for (size_t k = (size_t)hi + 1; k < cov.size(); k++)
            if (cov[k] == 1) atEnd = false;
        for (long k = 0; k < lo; k++)
            if (cov[(size_t)k] == 1) atStart = false;
        if (!atEnd && !atStart) continue;

        size_t cut;
        if (atEnd) {
            size_t b = (size_t)lo;
            while (b > 0 && cov[b - 1] != -1 &&
                   isWordCp(clusterCps[b - 1]) && isWordCp(clusterCps[b]))
                b--;
            if (b == 0) continue;
            cut = b;
        } else {
            size_t b = (size_t)hi + 1;
            while (b < cov.size() && cov[b] != -1 &&
                   isWordCp(clusterCps[b]) && isWordCp(clusterCps[b - 1]))
                b++;
            if (b >= cov.size()) continue;
            cut = b;
        }
        const size_t cutOff = starts[cut];
        if (cutOff == 0 || cutOff >= t.size()) continue;
        std::u16string keepText = atEnd ? t.substr(0, cutOff) : t.substr(cutOff);
        std::u16string subText = atEnd ? t.substr(cutOff) : t.substr(0, cutOff);

        std::vector<uint32_t> keepCps;
        for (char16_t c : keepText)
            if (c != u'\n' && c != u'\r' && c != u' ') keepCps.push_back(c == 0x00AD ? u'-' : c);
        keepCps.push_back(u' ');
        std::vector<uint32_t> subCps;
        for (char16_t c : subText)
            if (c != u'\n' && c != u'\r' && c != u' ') subCps.push_back(c == 0x00AD ? u'-' : c);
        if (!fontCovers(s, r0.originalFont, keepCps)) continue;
        if (!subCps.empty() && fontCovers(s, r0.originalFont, subCps)) continue;
        ParaRun keep = r0, sub = r0;
        keep.text = std::move(keepText);
        sub.text = std::move(subText);
        keep.textUnchanged = true;
        sub.textUnchanged = false;
        layoutRuns.erase(layoutRuns.begin() + static_cast<long>(i));
        if (atEnd) {
            layoutRuns.insert(layoutRuns.begin() + static_cast<long>(i), {keep, sub});
        } else {
            layoutRuns.insert(layoutRuns.begin() + static_cast<long>(i), {sub, keep});
        }
        i += 1;
    }

    auto rtlShapable = [](const std::u16string& t) {
        for (char16_t c : t) {
            if ((c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) ||
                (c >= 0x08A0 && c <= 0x08FF) || (c >= 0xFB50 && c <= 0xFDFF) ||
                (c >= 0xFE70 && c <= 0xFEFC))
                return true;
            if (c >= 0x05B0 && c <= 0x05C7 && c != 0x05BE && c != 0x05C0 &&
                c != 0x05C3 && c != 0x05C6)
                return true;
        }
        return false;
    };
    auto hasArabicJoinable = [](const std::u16string& t) {
        for (char16_t c : t)
            if ((c >= 0x0620 && c <= 0x064A) || (c >= 0x066E && c <= 0x06D3) ||
                (c >= 0x0750 && c <= 0x077F) || (c >= 0x08A0 && c <= 0x08FF))
                return true;
        return false;
    };

    auto hbQualifies = [&](const std::vector<uint8_t>* bytes,
                           const std::u16string& logical, bool requireInk = false) {
        if (!bytes) return false;
        if (!hbShapesCleanly(bytes->data(), bytes->size(), logical, requireInk))
            return false;
        if (hasArabicJoinable(logical) &&
            !hbFontShapesArabic(bytes->data(), bytes->size()))
            return false;
        return true;
    };

    std::vector<std::u16string> presText(layoutRuns.size());
    std::vector<char> hbCleanOrig(layoutRuns.size(), 0);

    std::vector<char> rtlForceSub(layoutRuns.size(), 0);
    if (paraRtl) {
        bool joins = false;

        auto coversPres = [&](FPDF_FONT f, const std::u16string& pres,
                              bool strict) {
            bool any = false;
            for (char16_t c : pres) {
                if (c == u' ' || c == u'\n' || c == u'\r' || c == 0x00A0) continue;
                const bool has = fontCovers(s, f, {static_cast<uint32_t>(c)});
                if (has && !strict) return true;
                if (!has && strict) return false;
                any = any || has;
            }
            return any;
        };
        for (size_t i = 0; i < layoutRuns.size(); i++) {
            presText[i] = layoutRuns[i].text;

            FPDF_FONT lf = layoutRuns[i].originalFont;
            std::function<bool(char16_t)> covers =
                [&s, lf](char16_t form) {
                    return lf && fontCovers(s, lf, {static_cast<uint32_t>(form)});
                };
            shapeArabicInPlace(presText[i], &joins, lf ? &covers : nullptr);
            if (rtlShapable(layoutRuns[i].text) && layoutRuns[i].originalFont) {
                hbCleanOrig[i] =
                    hbQualifies(fontBytesFor(s, layoutRuns[i].originalFont),
                                layoutRuns[i].text, !previewJson)
                        ? 1
                        : 0;
                if (!hbCleanOrig[i] &&
                    !coversPres(layoutRuns[i].originalFont, presText[i],
                                !previewJson))
                    rtlForceSub[i] = 1;
            }
        }
    }

    {
        std::vector<ParaRun> splitRuns;
        splitRuns.reserve(layoutRuns.size());
        for (auto& r : layoutRuns) {
            bool eligible = r.originalFont && !r.textUnchanged &&
                            !r.atomicObject && r.text.size() >= 2 &&
                            !paraRtl && !textNeedsComplexShaping(r.text);
            if (eligible) {
                std::vector<uint32_t> all;
                for (size_t ci = 0; ci < r.text.size(); ci++) {
                    uint32_t cp = r.text[ci];
                    if (cp >= 0xD800 && cp <= 0xDBFF &&
                        ci + 1 < r.text.size()) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) +
                             (r.text[ci + 1] - 0xDC00);
                        ci++;
                    }
                    if (cp != u'\n' && cp != u'\r') all.push_back(cp);
                }

                eligible = !all.empty();
            }
            if (!eligible) {
                splitRuns.push_back(std::move(r));
                continue;
            }
            std::vector<char> cov(r.text.size(), 1);
            bool anyYes = false;
            for (size_t ci = 0; ci < r.text.size(); ci++) {
                uint32_t cp = r.text[ci];
                const size_t ci0 = ci;
                if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < r.text.size() &&
                    r.text[ci + 1] >= 0xDC00 && r.text[ci + 1] <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) +
                         (r.text[ci + 1] - 0xDC00);
                    ci++;
                }
                if (cp == u'\n' || cp == u'\r' || cp == u' ' ||
                    cp == 0x00A0 || cp == u'\t')
                    continue;
                const bool c2 = fontCovers(s, r.originalFont, {cp});
                cov[ci0] = c2 ? 1 : 0;
                if (ci != ci0) cov[ci0 + 1] = cov[ci0];
                if (c2) anyYes = true;
            }
            if (!anyYes) {
                splitRuns.push_back(std::move(r));
                continue;
            }

            {
                auto isWordU = [](char16_t u) {
                    return (u >= u'0' && u <= u'9') || (u >= u'A' && u <= u'Z') ||
                           (u >= u'a' && u <= u'z') || u >= 0x00C0;
                };
                size_t ci = 0;
                while (ci < r.text.size()) {
                    if (!isWordU(r.text[ci])) { ci++; continue; }
                    size_t en = ci;
                    bool bad = false;
                    while (en < r.text.size() && isWordU(r.text[en])) {
                        if (!cov[en]) bad = true;
                        en++;
                    }
                    if (bad)
                        for (size_t w = ci; w < en; w++) cov[w] = 0;
                    ci = en;
                }
            }
            for (size_t ci = 1; ci < cov.size(); ci++) {
                const char16_t u = r.text[ci];
                if (u == u' ' || u == 0x00A0 || u == u'\t' || u == u'\n' ||
                    u == u'\r')
                    cov[ci] = cov[ci - 1];
            }
            size_t st2 = 0;
            while (st2 < r.text.size()) {
                size_t en = st2;
                while (en < r.text.size() && cov[en] == cov[st2]) en++;
                ParaRun piece = r;
                piece.text = r.text.substr(st2, en - st2);
                piece.srcAdv.clear();
                if (r.srcAdv.size() == r.text.size())
                    piece.srcAdv.assign(
                        r.srcAdv.begin() + static_cast<long>(st2),
                        r.srcAdv.begin() + static_cast<long>(en));
                if (!cov[st2]) {
                    piece.scriptFallbackFont = piece.originalFont;
                    piece.originalFont = nullptr;
                    piece.srcAdv.clear();
                } else {

                    piece.textUnchanged = true;
                }
                splitRuns.push_back(std::move(piece));
                st2 = en;
            }
        }
        layoutRuns = std::move(splitRuns);

        if (presText.size() < layoutRuns.size()) {
            const size_t old = presText.size();
            presText.resize(layoutRuns.size());
            for (size_t k = old; k < layoutRuns.size(); k++)
                presText[k] = layoutRuns[k].text;
        }
        hbCleanOrig.resize(layoutRuns.size(), 0);
        rtlForceSub.resize(layoutRuns.size(), 0);
    }

    std::vector<ResolvedRun> resolved;
    for (size_t rix = 0; rix < layoutRuns.size(); rix++) {
        ParaRun& r = layoutRuns[rix];

        const bool legacyRtl = paraRtl && r.originalFont && !hbCleanOrig[rix] &&
                               !rtlForceSub[rix] && rtlShapable(r.text);
        const std::u16string& probeText = legacyRtl ? presText[rix] : r.text;
        std::vector<uint32_t> cps;
        std::set<uint32_t> seen;
        for (size_t ci = 0; ci < probeText.size(); ci++) {
            uint32_t cp = probeText[ci];
            if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < probeText.size() &&
                probeText[ci + 1] >= 0xDC00 && probeText[ci + 1] <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (probeText[ci + 1] - 0xDC00);
                ci++;
            }
            if (cp == u'\n' || cp == u'\r') continue;
            if (cp == 0x00AD) cp = u'-';
            if (seen.insert(cp).second) cps.push_back(cp);
        }
        if (seen.insert(u' ').second) cps.push_back(u' ');
        ResolvedRun rr;
        rr.run = &r;

        bool subsetProven = false;
        if (!r.textUnchanged && r.originalFont && !r.text.empty() &&
            fontIsSubset(r.originalFont)) {
            auto itc = s.fontRenderedCps.find(r.originalFont);
            if (itc != s.fontRenderedCps.end() && !itc->second.empty()) {
                subsetProven = true;
                for (size_t ci = 0; ci < r.text.size() && subsetProven; ci++) {
                    uint32_t cp = r.text[ci];
                    if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < r.text.size() &&
                        r.text[ci + 1] >= 0xDC00 && r.text[ci + 1] <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) +
                             (r.text[ci + 1] - 0xDC00);
                        ci++;
                    }
                    if (cp == u'\n' || cp == u'\r') continue;
                    if (!itc->second.count(cp)) subsetProven = false;
                }
            }
        }

        rr.font = r.atomicObject && r.originalFont
                      ? r.originalFont
                      : resolveFont(s, r.style,
                                    fragilePage ? nullptr : r.originalFont, cps,
                                    !fragilePage &&
                                        (r.textUnchanged || subsetProven) &&
                                        !rtlForceSub[rix],
                                    r.scriptFallbackFont,
                                    fragilePage ? r.originalFont : nullptr);
        rr.emitSize = r.style.script != 0 ? r.style.size * kSuperScale : r.style.size;
        rr.baseShift = (r.style.script > 0   ? r.style.size * kSuperShift
                        : r.style.script < 0 ? r.style.size * kSubShift
                                             : 0.0f) +
                       r.style.rise;
        rr.hScale = r.style.hScale > 0.01f ? r.style.hScale : 1.0f;
        if (!rr.font) return false;

        if (r.layoutSrc >= 0 && r.layoutSrc < static_cast<int>(p.runs.size()) &&
            !p.runs[static_cast<size_t>(r.layoutSrc)].boundFont) {
            p.runs[static_cast<size_t>(r.layoutSrc)].boundFont = rr.font;
        }
        resolved.push_back(rr);
    }

    for (size_t i = 0; i < resolved.size(); i++) {
        ResolvedRun& rr = resolved[i];
        const std::u16string& logical = rr.run->text;
        const bool script = textNeedsComplexShaping(logical);
        const bool rtlHb = paraRtl && rtlShapable(logical);
        const bool providerSubset =
            rr.font && s.providerFonts.count(rr.font) > 0 &&
            rr.font != rr.run->originalFont;
        if (!script && !rtlHb && !providerSubset) continue;
        rr.hbBytes = fontBytesFor(s, rr.font);
        if (rr.hbBytes && !script && !rtlHb && providerSubset) {
            rr.complex = true;
            continue;
        }
        if (rr.hbBytes && !script && rtlHb &&
            !hbQualifies(rr.hbBytes, logical)) {
            rr.hbBytes = nullptr;
        }
        rr.complex = rr.hbBytes != nullptr;
    }

    if (paraRtl) {
        for (size_t i = 0; i < layoutRuns.size(); i++)
            if (!resolved[i].complex) layoutRuns[i].text = presText[i];
    }

    const float charSpacing = p.fmt.char_spacing;
    const float wrapSlack = 1.6f;

    std::map<std::pair<FPDF_FONT, char16_t>, uint32_t> probeCache;

    std::map<std::pair<FPDF_FONT, char16_t>, std::deque<uint32_t>> origCodePool;
    {
        for (const ParaRun& pr : p.runs) {
            if (!pr.originalFont) continue;
            if (pr.srcCodes.size() != pr.srcText.size()) continue;
            for (size_t ci2 = 0; ci2 < pr.srcText.size(); ci2++) {
                const uint32_t code = pr.srcCodes[ci2];
                if (code == 0xFFFFFFFFu) continue;
                origCodePool[{pr.originalFont, pr.srcText[ci2]}].push_back(code);
            }
        }
    }
    auto takeOrigCode = [&](FPDF_FONT font, char16_t ch) -> uint32_t {
        if (!font) return 0xFFFFFFFFu;
        auto it2 = origCodePool.find({font, ch});
        if (it2 == origCodePool.end() || it2->second.empty()) return 0xFFFFFFFFu;
        const uint32_t code = it2->second.front();
        it2->second.pop_front();
        return code;
    };
    std::map<FPDF_FONT, bool> spaceOkCache;
    auto fontHasRealSpace = [&](FPDF_FONT f) {
        auto itc = spaceOkCache.find(f);
        if (itc != spaceOkCache.end()) return itc->second;
        bool ok = false;
        float w = 0;
        if (f && FPDFFont_GetGlyphWidth(f, u' ', 12.0f, &w) && w > 0.001f) {

            ok = true;
            FPDF_GLYPHPATH gp = FPDFFont_GetGlyphPath(f, u' ', 12.0f);
            if (gp && FPDFGlyphPath_CountGlyphSegments(gp) > 0) ok = false;
        }
        if (ok) {

            FPDF_PAGEOBJECT probe = FPDFPageObj_CreateTextObj(s.doc, f, 12.0f);
            if (probe) {
                unsigned short sp[2] = {u' ', 0};
                float l = 0, b = 0, r = 0, t = 0;
                if (FPDFText_SetText(probe, sp) &&
                    FPDFPageObj_GetBounds(probe, &l, &b, &r, &t) &&
                    (r - l) > 0.01f && (t - b) > 0.01f) {
                    ok = false;
                }
                FPDFPageObj_Destroy(probe);
            }
        }
        spaceOkCache.emplace(f, ok);
        return ok;
    };

    auto advanceOf = [&](int ri, uint32_t cp) {
        const uint32_t measured = cp == 0x00A0 ? u' ' : cp;

        const float tw = measured == u' ' ? p.fmt.word_spacing : 0.0f;
        return (glyphAdvance(resolved[ri].font, measured, resolved[ri].emitSize) +
                charSpacing + tw) *
               resolved[ri].hScale;
    };

    auto srcAdvMatchesFont = [&](int ri) {
        const ParaRun& lr = layoutRuns[static_cast<size_t>(ri)];
        if (resolved[static_cast<size_t>(ri)].font == lr.originalFont)
            return true;
        float have = 0.0f, want = 0.0f;
        int n = 0;
        for (size_t ci = 0; ci < lr.text.size() && n < 8; ci++) {
            const char16_t u = lr.text[ci];
            if (u < 0x21 || (u >= 0xD800 && u <= 0xDFFF)) continue;
            const float a = lr.srcAdv[ci];
            if (a <= 0.0f) continue;
            have += advanceOf(ri, u);
            want += a;
            n++;
        }
        if (!n || want <= 0.001f) return false;
        const float ratio = have / want;
        return ratio > 0.97f && ratio < 1.03f;
    };

    struct ShapedEntry {
        std::vector<ShapedGlyph> g;
        std::vector<uint32_t> cids;
    };
    std::map<std::pair<int, std::u16string>, ShapedEntry> hbShaped;
    auto shapedFor = [&](int ri, const std::u16string& txt) -> ShapedEntry* {
        if (!resolved[ri].complex || txt.empty()) return nullptr;
        auto key = std::make_pair(ri, txt);
        auto it = hbShaped.find(key);
        if (it == hbShaped.end()) {
            ShapedEntry e;
            hbShapeText(resolved[ri].hbBytes->data(), resolved[ri].hbBytes->size(),
                        txt, e.g);
            it = hbShaped.emplace(key, std::move(e)).first;
        }
        return it->second.g.empty() ? nullptr : &it->second;
    };
    auto complexSegWidth = [&](int ri, const std::u16string& txt) -> float {
        ShapedEntry* e = shapedFor(ri, txt);
        if (!e) return -1.0f;
        float w = 0;
        for (const auto& g : e->g) w += g.advance;
        const ResolvedRun& rr = resolved[ri];

        return (w * rr.emitSize / 1000.0f +
                charSpacing * static_cast<float>(e->g.size())) *
               rr.hScale;
    };

    auto wordSegsForEach =
        [&](const Token& t,
            const std::function<void(int, const std::u16string&)>& fn) {
            int curRi = -1;
            std::u16string seg;
            for (const auto& pr : t.chars) {
                if (pr.second != curRi && !seg.empty()) {
                    fn(curRi, seg);
                    seg.clear();
                }
                curRi = pr.second;
                appendCodepointUtf16(seg, pr.first);
            }
            if (!seg.empty()) fn(curRi, seg);
        };
    auto tokenHasComplex = [&](const Token& t) {
        for (const auto& pr : t.chars)
            if (resolved[pr.second].complex) return true;
        return false;
    };

    auto wordWidth = [&](const Token& t) -> float {
        float w = 0;
        size_t k = 0;
        while (k < t.chars.size()) {
            const int ri = t.chars[k].second;
            size_t k2 = k;
            std::u16string segText;
            while (k2 < t.chars.size() && t.chars[k2].second == ri) {
                appendCodepointUtf16(segText, t.chars[k2].first);
                k2++;
            }
            const float cw =
                resolved[ri].complex ? complexSegWidth(ri, segText) : -1.0f;
            if (cw >= 0) {
                w += cw;
            } else {
                for (size_t j = k; j < k2; j++) {
                    const float ov = t.advs.empty() ? -1.0f : t.advs[j];
                    w += ov >= 0 ? ov : advanceOf(ri, t.chars[j].first);
                }
            }
            k = k2;
        }
        return w;
    };

    int srcAdvUsed = 0;
    const bool srcAdvOk =
        std::abs(p.fmt.char_spacing - p.srcCharSpacing) < 0.005f;

    bool anyEdited = false;
    for (const auto& r : layoutRuns) {
        if (!r.textUnchanged || !r.originalFont) {
            anyEdited = true;
            break;
        }
    }
    std::vector<Token> tokens;
    Token word;
    auto flushWord = [&]() {
        if (!word.chars.empty()) {
            tokens.push_back(word);
            word = Token();
        }
    };

    std::vector<uint8_t> bidiLv;
    std::vector<size_t> runUnitStart(layoutRuns.size(), 0);
    {
        std::u16string all;
        for (size_t ri = 0; ri < layoutRuns.size(); ri++) {
            runUnitStart[ri] = all.size();
            all += layoutRuns[ri].text;
        }
        bidiLv = bidiLevels(all, p.fmt.dir ? p.fmt.dir : (paraRtl ? 2 : 1));
    }
    for (size_t ri = 0; ri < layoutRuns.size(); ri++) {

        if (layoutRuns[ri].atomicObject) {
            flushWord();
            Token t;
            t.kind = Token::Word;
            t.chars.push_back({0xFFFC, static_cast<int>(ri)});
            t.advs.push_back(layoutRuns[ri].atomicW);
            t.offs.push_back(0);
            t.width = layoutRuns[ri].atomicW;
            tokens.push_back(t);
            continue;
        }
        const std::u16string& text = layoutRuns[ri].text;

        const std::vector<float>* sa =
            (srcAdvOk && !resolved[ri].complex &&
             layoutRuns[ri].srcAdv.size() == text.size() &&
             srcAdvMatchesFont(static_cast<int>(ri)))
                ? &layoutRuns[ri].srcAdv
                : nullptr;
        if (sa) srcAdvUsed++;
        for (size_t ci = 0; ci < text.size(); ci++) {
            uint32_t cp = text[ci];
            const size_t ci0 = ci;
            if (cp >= 0xD800 && cp <= 0xDBFF && ci + 1 < text.size() &&
                text[ci + 1] >= 0xDC00 && text[ci + 1] <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (text[ci + 1] - 0xDC00);
                ci++;
            }
            const float ov = sa ? (*sa)[ci0] : -1.0f;
            const uint8_t lvl = bidiLv[runUnitStart[ri] + ci0];
            if (cp == u'\r') continue;
            if (cp == u'\n') {
                flushWord();

                {
                    Token t;
                    t.kind = Token::Break;
                    tokens.push_back(t);
                }
            } else if (cp == 0x00AD) {

                flushWord();
                if (!tokens.empty() && tokens.back().kind == Token::Word) {
                    tokens.back().softHyphen = true;
                }
            } else if (isBreakableSpace(cp)) {
                flushWord();
                Token t;
                t.kind = Token::Space;
                t.level = lvl;
                t.runIndex = static_cast<int>(ri);
                t.off = ci0;

                const bool atomicNbr =
                    (ri > 0 && layoutRuns[ri - 1].atomicObject) ||
                    (ri + 1 < layoutRuns.size() &&
                     layoutRuns[ri + 1].atomicObject);
                if (cp == u'\t') {

                    float w = ov;
                    if (w < 0.0f && ci0 < layoutRuns[ri].srcAdv.size())
                        w = layoutRuns[ri].srcAdv[ci0];
                    t.width = w > 0.0f
                                  ? w
                                  : 4.0f * advanceOf(static_cast<int>(ri), u' ');
                } else {

                    t.width = (ov >= 0 && std::abs(p.fmt.word_spacing) < 0.005f &&
                               (!anyEdited || atomicNbr ||
                                layoutRuns[ri].textUnchanged))
                                  ? ov
                                  : advanceOf(static_cast<int>(ri), u' ');
                }
                tokens.push_back(t);
            } else {

                if (!word.chars.empty() && word.level != lvl) flushWord();
                word.level = lvl;
                word.chars.push_back({cp, static_cast<int>(ri)});
                word.advs.push_back(ov);
                word.offs.push_back(ci0);
            }
        }
    }
    flushWord();

    if (autoWiden && preEditLineCount == 1 && p.rotation == 0) {
        bool hasBreak = false;
        float natural = 0, trailingSpace = 0;
        for (const auto& t : tokens) {
            if (t.kind == Token::Break || t.kind == Token::ParaBreak) {
                hasBreak = true;
                break;
            }
            float w = 0;
            if (t.kind == Token::Word) {
                w = wordWidth(t);
                natural += w + trailingSpace;
                trailingSpace = 0;
            } else if (t.kind == Token::Space) {
                trailingSpace += t.width > 0 ? t.width : advanceOf(t.runIndex, u' ');
            }
        }

        if (!hasBreak && natural > p.width + 1.0f) {
            const float pageW = FPDF_GetPageWidthF(page);
            const float MARGIN = 2.0f;
            float newW = natural + 0.5f;

            if (p.fmt.align == 1) {
                const float cx = p.x + p.width * 0.5f;
                const float room = 2.0f * std::max(0.0f,
                    std::min(cx - MARGIN, pageW - MARGIN - cx));
                newW = std::min(newW, room);
                if (newW > p.width) { p.x = cx - newW * 0.5f; p.width = newW; }
            } else if (p.fmt.align == 2) {
                const float rightEdge = p.x + p.width;
                newW = std::min(newW, rightEdge - MARGIN);
                if (newW > p.width) { p.x = rightEdge - newW; p.width = newW; }
            } else {
                newW = std::min(newW, pageW - MARGIN - p.x);
                if (newW > p.width) p.width = newW;
            }
        }
    }

    {
        std::vector<Token> fitted;
        fitted.reserve(tokens.size());
        for (auto& t : tokens) {
            if (t.kind != Token::Word) {
                fitted.push_back(t);
                continue;
            }
            float w = wordWidth(t);
            if (w <= p.width + wrapSlack) {
                t.width = w;
                fitted.push_back(t);
                continue;
            }
            if (tokenHasComplex(t)) {

                std::vector<char> isStart(t.chars.size(), 1);
                size_t ci = 0;
                while (ci < t.chars.size()) {
                    const int ri = t.chars[ci].second;
                    size_t cj = ci;
                    std::u16string segText;
                    std::vector<size_t> charAtUnit;
                    while (cj < t.chars.size() && t.chars[cj].second == ri) {
                        const size_t before = segText.size();
                        appendCodepointUtf16(segText, t.chars[cj].first);
                        for (size_t u = before; u < segText.size(); u++)
                            charAtUnit.push_back(cj);
                        cj++;
                    }
                    if (resolved[ri].complex) {
                        ShapedEntry* e = shapedFor(ri, segText);
                        if (e) {
                            for (size_t k = ci; k < cj; k++) isStart[k] = 0;
                            for (const auto& g : e->g)
                                if (g.cluster < charAtUnit.size())
                                    isStart[charAtUnit[g.cluster]] = 1;
                            isStart[ci] = 1;
                        }
                    }
                    ci = cj;
                }
                Token part;
                part.kind = Token::Word;
                float pw = 0;
                for (size_t k = 0; k < t.chars.size();) {
                    size_t k2 = k + 1;
                    while (k2 < t.chars.size() && !isStart[k2]) k2++;
                    Token cl;
                    cl.kind = Token::Word;
                    cl.chars.assign(t.chars.begin() + static_cast<long>(k),
                                    t.chars.begin() + static_cast<long>(k2));
                    if (!t.advs.empty())
                        cl.advs.assign(t.advs.begin() + static_cast<long>(k),
                                       t.advs.begin() + static_cast<long>(k2));
                    if (!t.offs.empty())
                        cl.offs.assign(t.offs.begin() + static_cast<long>(k),
                                       t.offs.begin() + static_cast<long>(k2));
                    const float cw = wordWidth(cl);
                    if (!part.chars.empty() && pw + cw > p.width + wrapSlack) {
                        part.width = wordWidth(part);
                        fitted.push_back(part);
                        part = Token();
                        part.kind = Token::Word;
                        pw = 0;
                    }
                    part.chars.insert(part.chars.end(), cl.chars.begin(),
                                      cl.chars.end());
                    part.advs.insert(part.advs.end(), cl.advs.begin(),
                                     cl.advs.end());
                    part.offs.insert(part.offs.end(), cl.offs.begin(),
                                     cl.offs.end());
                    pw += cw;
                    k = k2;
                }
                if (!part.chars.empty()) {
                    part.width = wordWidth(part);
                    part.softHyphen = t.softHyphen;
                    fitted.push_back(part);
                }
                continue;
            }
            Token part;
            part.kind = Token::Word;
            float pw = 0;
            for (size_t k = 0; k < t.chars.size(); k++) {
                const auto& pr = t.chars[k];
                const float ov = t.advs.empty() ? -1.0f : t.advs[k];
                float adv = ov >= 0 ? ov : advanceOf(pr.second, pr.first);
                if (!part.chars.empty() && pw + adv > p.width + wrapSlack) {
                    part.width = pw;
                    fitted.push_back(part);
                    part = Token();
                    part.kind = Token::Word;
                    pw = 0;
                }
                part.chars.push_back(pr);
                if (!t.advs.empty()) part.advs.push_back(t.advs[k]);
                if (!t.offs.empty()) part.offs.push_back(t.offs[k]);
                pw += adv;
            }
            if (!part.chars.empty()) {
                part.width = pw;
                part.softHyphen = t.softHyphen;
                fitted.push_back(part);
            }
        }
        tokens = std::move(fitted);
    }

    struct WrappedLine {
        std::vector<const Token*> tokens;
        float naturalWidth = 0;
        bool endsHard = false;
        float extraAfter = 0;
        int hyphenRun = -1;

        float segL = 0;
        float segR = -1;
    };
    std::vector<WrappedLine> wrapped;
    WrappedLine current;
    float x = 0;

    float obsDomSize = 12.0f;
    if (!p.obstacles.empty()) {
        std::vector<float> sz;
        for (const auto& rr : layoutRuns)
            if (rr.style.size > 1) sz.push_back(rr.style.size);
        if (!sz.empty()) {
            std::sort(sz.begin(), sz.end());
            obsDomSize = sz[sz.size() / 2];
        }
    }
    float obsBaseline = p.top - 0.85f * obsDomSize;
    auto currentSeg = [&]() -> std::pair<float, float> {
        float L = 0, R = p.width;
        if (p.obstacles.empty()) return {L, R};
        const float yT = obsBaseline + 1.0f * obsDomSize;
        const float yB = obsBaseline - 0.3f * obsDomSize;
        for (const auto& ob : p.obstacles) {
            if (yB > ob.top || yT < ob.bottom) continue;
            const float obL = ob.left - p.x, obR = ob.right - p.x;
            if (obR <= 0 || obL >= p.width) continue;
            if ((obL + obR) * 0.5f < p.width * 0.5f) L = std::max(L, obR);
            else R = std::min(R, obL);
        }
        if (R - L < 20.0f) { L = 0; R = p.width; }
        return {L, R};
    };
    std::pair<float, float> obsSeg = currentSeg();

    bool hardStart = true;
    auto flushLine = [&](bool hard, float extra) {

        while (!current.tokens.empty() && current.tokens.back()->kind == Token::Space) {
            x -= current.tokens.back()->width;
            current.tokens.pop_back();
        }

        if (!hard && !current.tokens.empty()) {
            const Token* last = current.tokens.back();
            if (last->kind == Token::Word && last->softHyphen && !last->chars.empty()) {
                current.hyphenRun = last->chars.back().second;
                x += advanceOf(current.hyphenRun, u'-');
            }
        }
        current.naturalWidth = std::max(0.0f, x);
        current.endsHard = hard;
        current.extraAfter = extra;
        current.segL = obsSeg.first;
        current.segR = obsSeg.second;
        wrapped.push_back(current);
        if (!p.obstacles.empty()) {

            float ms = 0;
            for (const Token* t : wrapped.back().tokens) {
                if (t->kind == Token::Word)
                    for (auto& [c, ri] : t->chars)
                        ms = std::max(ms, resolved[ri].run->style.size);
                else if (t->kind == Token::Space)
                    ms = std::max(ms, resolved[t->runIndex].run->style.size);
            }
            if (ms <= 0) ms = obsDomSize;
            obsBaseline -= p.fmt.line_spacing * ms + extra;
            obsSeg = currentSeg();
        }
        current = WrappedLine();
        x = 0;
        hardStart = hard;
    };

    const bool srcHang =
        std::abs(p.fmt.hang_indent - p.srcHangIndent) < 0.01f;
    auto effWidth = [&]() {
        const float inset =
            wrapped.empty() ? p.fmt.first_indent
                            : ((hardStart && srcHang) ? 0.0f : p.fmt.hang_indent);
        return std::max(20.0f, p.width - inset);
    };

    if (!p.pinnedBreaks.empty() && !paraRtl) {
        std::vector<long> base(p.runs.size() + 1, 0);
        for (size_t i = 0; i < p.runs.size(); i++)
            base[i + 1] = base[i] + static_cast<long>(p.runs[i].text.size());
        std::vector<Token> split;
        split.reserve(tokens.size());
        for (const Token& t : tokens) {
            if (t.kind != Token::Word || t.offs.size() != t.chars.size() ||
                t.chars.empty()) {
                split.push_back(t);
                continue;
            }
            auto flatAt = [&](size_t j) {
                const int ri = t.chars[j].second;
                return ri >= 0 && ri < static_cast<int>(p.runs.size())
                           ? base[static_cast<size_t>(ri)] +
                                 static_cast<long>(t.offs[j])
                           : -1L;
            };
            size_t from = 0;
            for (size_t j = 1; j < t.chars.size(); j++) {
                const long f = flatAt(j);
                if (f < 0) continue;
                bool isPin = false;
                for (size_t q = 1; q < p.pinnedBreaks.size() && !isPin; q++)
                    isPin = p.pinnedBreaks[q] == f;
                if (!isPin) continue;
                Token piece;
                piece.kind = Token::Word;
                piece.level = t.level;
                piece.chars.assign(t.chars.begin() + static_cast<long>(from),
                                   t.chars.begin() + static_cast<long>(j));
                if (!t.advs.empty())
                    piece.advs.assign(t.advs.begin() + static_cast<long>(from),
                                      t.advs.begin() + static_cast<long>(j));
                piece.offs.assign(t.offs.begin() + static_cast<long>(from),
                                  t.offs.begin() + static_cast<long>(j));
                piece.width = wordWidth(piece);
                split.push_back(std::move(piece));
                from = j;
            }
            if (from == 0) { split.push_back(t); continue; }
            Token tail;
            tail.kind = Token::Word;
            tail.level = t.level;
            tail.softHyphen = t.softHyphen;
            tail.chars.assign(t.chars.begin() + static_cast<long>(from), t.chars.end());
            if (!t.advs.empty())
                tail.advs.assign(t.advs.begin() + static_cast<long>(from), t.advs.end());
            tail.offs.assign(t.offs.begin() + static_cast<long>(from), t.offs.end());
            tail.width = wordWidth(tail);
            split.push_back(std::move(tail));
        }
        tokens = std::move(split);
    }

    std::vector<long> runBase(p.runs.size() + 1, 0);
    for (size_t i = 0; i < p.runs.size(); i++)
        runBase[i + 1] = runBase[i] + static_cast<long>(p.runs[i].text.size());
    auto flatOf = [&](const Token& t) -> long {
        const int ri = t.kind == Token::Space ? t.runIndex
                       : (t.chars.empty() ? -1 : t.chars[0].second);
        if (ri < 0 || ri >= static_cast<int>(p.runs.size())) return -1;
        const size_t off = t.kind == Token::Space
                               ? t.off
                               : (t.offs.empty() ? 0 : t.offs[0]);
        return runBase[static_cast<size_t>(ri)] + static_cast<long>(off);
    };

    const bool pinned = !p.pinnedBreaks.empty() && !paraRtl;
    size_t pinAt = 1;
    for (const auto& t : tokens) {

        const long tf = pinned ? flatOf(t) : -1;

        while (tf >= 0 && pinAt < p.pinnedBreaks.size() &&
               p.pinnedBreaks[pinAt] <= tf) {
            if (!current.tokens.empty()) flushLine(false, 0);

            hardStart = true;
            pinAt++;
        }
        switch (t.kind) {
            case Token::Break:
                flushLine(true, 0);
                break;
            case Token::ParaBreak:
                flushLine(true, p.fmt.para_spacing);
                break;
            case Token::Space:

                if (current.tokens.empty() && hardStart && obsSeg.first > 4.0f)
                    break;
                if (!current.tokens.empty() || hardStart) {
                    current.tokens.push_back(&t);
                    x += t.width;
                }
                break;
            case Token::Word: {
                const float avail = std::min(effWidth(), obsSeg.second) - obsSeg.first;

                float tail = 0;
                for (const auto& pr : t.chars)
                    tail = std::max(tail, 0.12f * resolved[pr.second].run->style.size);
                tail += charSpacing;

                if (!pinned && !current.tokens.empty() &&
                    x + t.width > avail + 0.5f + tail) {
                    flushLine(false, 0);
                }
                current.tokens.push_back(&t);
                x += t.width;
                break;
            }
        }
    }
    if (!current.tokens.empty()) flushLine(true, 0);
    if (wrapped.empty()) {
        p.height = 0;
        return true;
    }

    if (preEditLineCount > 0 && wrapped.size() == preEditLineCount + 1 &&
        wrapped.size() >= 2) {
        WrappedLine& lastL = wrapped.back();
        WrappedLine& prevL = wrapped[wrapped.size() - 2];
        if (!prevL.endsHard && prevL.hyphenRun < 0 &&
            lastL.tokens.size() == 1 &&
            lastL.tokens[0]->kind == Token::Word &&
            !lastL.tokens[0]->chars.empty()) {
            const Token* w = lastL.tokens[0];
            float tokSize = 0;
            for (auto& [c, ri] : w->chars)
                tokSize = std::max(tokSize, resolved[ri].run->style.size);
            const int ri0 = w->chars[0].second;

            const Token* sep = w != &tokens.front() && (w - 1)->kind == Token::Space
                                   ? (w - 1)
                                   : nullptr;
            const bool afterWord =
                w != &tokens.front() && (w - 1)->kind == Token::Word;
            const float sepW =
                sep ? sep->width : (afterWord ? 0.0f : advanceOf(ri0, u' '));
            const float joined = prevL.naturalWidth + sepW + w->width;

            const ParaRun* wr = resolved[ri0].run;
            const bool originFits =
                wr->atomicObject &&
                wr->atomicX + wr->atomicW <= p.x + p.width + 0.5f;
            if (joined <= p.width + 0.62f * tokSize || originFits) {
                if (sep) prevL.tokens.push_back(sep);
                prevL.tokens.push_back(w);
                prevL.naturalWidth = joined;
                prevL.endsHard = lastL.endsHard;
                prevL.extraAfter = lastL.extraAfter;
                wrapped.pop_back();
            }
        }
    }

    float emptyLineSize = 0;
    for (const auto& rr : resolved)
        if (rr.run) emptyLineSize = std::max(emptyLineSize, rr.run->style.size);
    if (!(emptyLineSize > 0)) emptyLineSize = 12.0f;
    auto lineMaxSize = [&](const WrappedLine& ln) {
        float m = 0;
        for (const Token* t : ln.tokens) {
            if (t->kind == Token::Word) {
                for (auto& [c, ri] : t->chars) m = std::max(m, resolved[ri].run->style.size);
            } else if (t->kind == Token::Space) {
                m = std::max(m, resolved[t->runIndex].run->style.size);
            }
        }
        return m > 0 ? m : emptyLineSize;
    };
    auto lineMaxAscent = [&](const WrappedLine& ln) {
        float m = 0;
        for (const Token* t : ln.tokens) {
            if (t->kind != Token::Word) continue;
            for (auto& [c, ri] : t->chars) {
                m = std::max(m, fontAscent(resolved[ri].font, resolved[ri].run->style.size));
            }
        }
        return m > 0 ? m : lineMaxSize(ln) * 0.78f;
    };

    const int startInsertIdx = insertIdx;
    int emitted = 0;

    const float rotC = std::cos(p.rotation), rotS = std::sin(p.rotation);
    auto insertObject = [&](FPDF_PAGEOBJECT obj) {
        if (p.rotation != 0) {
            FS_MATRIX r{rotC, rotS, -rotS, rotC, 0, 0};
            FPDFPageObj_TransformF(obj, &r);
        }

        if (pageRot2 % 360 != 0) {
            FS_MATRIX pr{prC, prS, -prS, prC, 0, 0};
            FPDFPageObj_TransformF(obj, &pr);
        }
        if (backX != 0 || backY != 0) {
            FS_MATRIX tc{1, 0, 0, 1, backX, backY};
            FPDFPageObj_TransformF(obj, &tc);
        }
        int idx = -1;
        if (startInsertIdx >= 0) {
            const int want = startInsertIdx + emitted;
            if (want <= FPDFPage_CountObjects(page)) idx = want;
        }
        historyInsertObject(s, page, obj, idx);
        emitted++;
        p.objects.push_back({obj, nullptr});
    };

    const bool taggedPage = [&] {
        FPDF_STRUCTTREE st = FPDF_StructTree_GetForPage(page);
        const bool t = st && FPDF_StructTree_CountChildren(st) > 0;
        if (st) FPDF_StructTree_Close(st);
        return t;
    }();

    auto applyMarks = [&](FPDF_PAGEOBJECT obj) {
        if (p.marks.empty()) {
            if (taggedPage) FPDFPageObj_AddMark(obj, "Artifact");
            return;
        }
        for (const ContentMark& cm : p.marks) {
            FPDF_PAGEOBJECTMARK mk = FPDFPageObj_AddMark(obj, cm.name.c_str());
            if (!mk) continue;
            for (const auto& [k, v] : cm.intParams)
                FPDFPageObjMark_SetIntParam(s.doc, obj, mk, k.c_str(), v);
            for (const auto& [k, v] : cm.strParams)
                FPDFPageObjMark_SetStringParam(s.doc, obj, mk, k.c_str(),
                                               v.c_str());
        }
    };

    auto markDecoration = [&](FPDF_PAGEOBJECT obj) {
        if (taggedPage) FPDFPageObj_AddMark(obj, "Artifact");

        FPDFPageObj_AddMark(obj, "EC_Deco");
    };

    float baseline = p.top - lineMaxAscent(wrapped[0]);
    p.firstBaseline = baseline;
    float lastDescent = 0;
    std::string previewLines;

    {
        bool anyComplex = false;
        for (const auto& rr : resolved) anyComplex |= rr.complex;
        if (anyComplex && previewJson) {

            anyComplex = false;
        }
        if (anyComplex) {
            for (const auto& wl : wrapped) {
                for (const Token* t : wl.tokens) {
                    if (t->kind == Token::Word && tokenHasComplex(*t)) {
                        wordSegsForEach(*t, [&](int ri, const std::u16string& sg) {
                            if (resolved[ri].complex) shapedFor(ri, sg);
                        });
                    } else if (t->kind == Token::Space &&
                               resolved[t->runIndex].complex) {
                        shapedFor(t->runIndex, std::u16string(u" "));
                    }
                }
                if (wl.hyphenRun >= 0 && resolved[wl.hyphenRun].complex)
                    shapedFor(wl.hyphenRun, std::u16string(u"-"));
            }
            for (size_t ri = 0; ri < resolved.size(); ri++) {
                if (!resolved[ri].complex) continue;
                uint32_t next = 1;
                std::vector<CidGlyphEntry> entries;
                std::vector<std::pair<uint32_t, std::u16string>> toUni;
                for (auto& [key, e] : hbShaped) {
                    if (key.first != static_cast<int>(ri) || e.g.empty()) continue;
                    const std::u16string& src = key.second;
                    e.cids.assign(e.g.size(), 0);
                    for (size_t i = 0; i < e.g.size(); i++) {
                        const bool first =
                            i == 0 || e.g[i].cluster != e.g[i - 1].cluster;

                        size_t clEnd = src.size();
                        for (const auto& g2 : e.g) {
                            if (g2.cluster > e.g[i].cluster &&
                                g2.cluster < clEnd)
                                clEnd = g2.cluster;
                        }
                        std::u16string mapText =
                            first ? src.substr(e.g[i].cluster,
                                               clEnd - e.g[i].cluster)
                                  : std::u16string(u"\u200B");
                        e.cids[i] = next++;
                        entries.push_back({e.g[i].gid, e.g[i].advance});
                        toUni.push_back({e.cids[i], mapText});
                    }
                }
                if (next == 1) { resolved[ri].complex = false; continue; }

                std::string cmap =
                    "/CIDInit /ProcSet findresource begin\n12 dict begin\n"
                    "begincmap\n/CMapName /Adobe-Identity-UCS def\n"
                    "/CMapType 2 def\n"
                    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
                char hex[16];
                for (size_t b = 0; b < toUni.size(); b += 100) {
                    const size_t nblk = std::min<size_t>(100, toUni.size() - b);
                    cmap += std::to_string(nblk) + " beginbfchar\n";
                    for (size_t k = b; k < b + nblk; k++) {
                        snprintf(hex, sizeof(hex), "<%04X> <",
                                 toUni[k].first & 0xFFFF);
                        cmap += hex;
                        for (char16_t ch : toUni[k].second) {
                            snprintf(hex, sizeof(hex), "%04X",
                                     static_cast<unsigned>(ch));
                            cmap += hex;
                        }
                        cmap += ">\n";
                    }
                    cmap += "endbfchar\n";
                }
                cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\n"
                        "end\nend\n";

                uint64_t h = 1469598103934665603ULL;
                auto mix = [&](uint64_t v) {
                    for (int bshift = 0; bshift < 64; bshift += 8) {
                        h ^= (v >> bshift) & 0xFF;
                        h *= 1099511628211ULL;
                    }
                };
                for (char fc : resolved[ri].run->style.family) mix((uint8_t)fc);
                for (const auto& en : entries) {
                    mix(en.srcGid);
                    mix(static_cast<uint64_t>(en.advance * 16.0f));
                }
                s.cidEmitSeq++;
                std::string tag = "AAAAAA+";
                for (uint64_t v = h, k = 0; k < 6; k++, v /= 26)
                    tag[5 - k] = static_cast<char>('A' + (v % 26));
                std::vector<uint8_t> built = buildCidEmissionFont(
                    resolved[ri].hbBytes->data(), resolved[ri].hbBytes->size(),
                    entries, tag + resolved[ri].run->style.family);
                if (built.empty()) { resolved[ri].complex = false; continue; }

                std::vector<uint8_t> cidToGid((entries.size() + 1) * 2, 0);
                for (size_t k = 0; k <= entries.size(); k++) {
                    cidToGid[k * 2] = static_cast<uint8_t>((k >> 8) & 0xFF);
                    cidToGid[k * 2 + 1] = static_cast<uint8_t>(k & 0xFF);
                }
                FPDF_FONT cf = FPDFText_LoadCidType2Font(
                    s.doc, built.data(), static_cast<uint32_t>(built.size()),
                    cmap.c_str(), cidToGid.data(),
                    static_cast<uint32_t>(cidToGid.size()));
                if (cf) {
                    s.fontBytes[cf] = std::move(built);
                    resolved[ri].cidFont = cf;
                    s.fontCache["cid#" + std::to_string(s.fontCache.size()) + "#" +
                                std::to_string(reinterpret_cast<uintptr_t>(cf))] = cf;
                } else {
                    resolved[ri].complex = false;
                }
            }
        }
    }

    for (size_t li = 0; li < wrapped.size(); li++) {
        const WrappedLine& ln = wrapped[li];
        const float maxSize = lineMaxSize(ln);

        if (li > 0) {
            baseline -= p.fmt.line_spacing * lineMaxSize(wrapped[li - 1]);
            baseline -= wrapped[li - 1].extraAfter;
        }

        const float lineIndent =
            li == 0 ? p.fmt.first_indent
                    : ((wrapped[li - 1].endsHard && srcHang) ? 0.0f
                                                             : p.fmt.hang_indent);
        float startX = p.x;
        float justifyExtra = 0;
        int gapCount = 0;
        {
            bool sawWord = false;
            for (const Token* t : ln.tokens) {
                if (t->kind == Token::Word) sawWord = true;
                else if (t->kind == Token::Space && sawWord) gapCount++;
            }
        }
        const float segL = ln.segL;
        const float segR = ln.segR < 0 ? p.width : ln.segR;
        const float leftover =
            (segR - std::max(segL, lineIndent)) - ln.naturalWidth;
        switch (p.fmt.align) {
            case 1:
                startX = p.x + segL + ((segR - segL) - ln.naturalWidth) / 2;
                break;
            case 2: startX = p.x + segR - ln.naturalWidth; break;
            case 3:
                startX = p.x + std::max(segL, lineIndent);
                if (!ln.endsHard && gapCount > 0 && leftover > 0) {
                    justifyExtra = leftover / static_cast<float>(gapCount);
                }
                break;
            default: startX = p.x + std::max(segL, lineIndent); break;
        }

        struct Seg {
            int runIndex = -1;
            std::u16string text;
            std::vector<uint32_t> cids;
            bool complex = false;
            std::vector<float> positions;
            float startX = 0;
            float width = 0;
        };
        std::vector<Seg> segs;
        if (previewJson) {

            int fr = -1;
            size_t fo = 0;
            for (const Token* t : ln.tokens) {
                if (t->kind == Token::Word && !t->offs.empty()) {
                    fr = t->chars[0].second;
                    fo = t->offs[0];
                    break;
                }
                if (t->kind == Token::Space) {
                    fr = t->runIndex;
                    fo = t->off;
                    break;
                }
            }

            long flat = -1;
            if (fr >= 0) {
                flat = static_cast<long>(fo);
                for (int ri2 = 0; ri2 < fr && ri2 < (int)p.runs.size(); ri2++) {
                    flat += static_cast<long>(p.runs[static_cast<size_t>(ri2)].text.size());
                }
            } else if (li < p.pinnedBreaks.size()) {

                flat = p.pinnedBreaks[li];
            }

            std::string cxJson = ",\"cx\":[";
            {
                float cxx = 0;
                bool sawWord2 = false, firstCx = true;
                char nb[24];
                auto emitCx = [&](float v) {
                    snprintf(nb, sizeof(nb), "%s%.2f", firstCx ? "" : ",", v);
                    cxJson += nb;
                    firstCx = false;
                };
                for (const Token* t : ln.tokens) {
                    if (t->kind == Token::Word) {
                        sawWord2 = true;
                        for (size_t j = 0; j < t->chars.size(); j++) {
                            const uint32_t cp = t->chars[j].first;
                            emitCx(cxx);
                            if (cp > 0xFFFF) emitCx(cxx);
                            cxx += (j < t->advs.size() && t->advs[j] >= 0)
                                       ? t->advs[j]
                                       : advanceOf(t->chars[j].second, cp);
                        }
                    } else if (t->kind == Token::Space) {
                        emitCx(cxx);
                        cxx += t->width + (sawWord2 ? justifyExtra : 0.0f);
                    }
                }
                emitCx(cxx);

                cxJson += "]";
            }
            char buf[200];
            snprintf(buf, sizeof(buf),
                     "%s{\"x\":%.3f,\"baseline\":%.3f,\"size\":%.3f,"
                     "\"run\":%d,\"off\":%zu,\"flat\":%ld,\"hard\":%d",
                     previewLines.empty() ? "" : ",", startX, baseline, maxSize,
                     fr, fo, flat, ln.endsHard ? 1 : 0);
            previewLines += buf;
            previewLines += cxJson;
            previewLines += "}";

            float descent = 0;
            for (const Token* t : ln.tokens) {
                if (t->kind != Token::Word) continue;
                for (auto& [c, ri] : t->chars) {
                    descent = std::max(
                        descent, fontDescent(resolved[ri].font,
                                             resolved[ri].run->style.size));
                }
            }
            lastDescent = descent > 0 ? descent : maxSize * 0.22f;
            continue;
        }
        float cx = startX;
        Seg seg;
        auto flushSeg = [&]() {
            if (!seg.text.empty() || !seg.cids.empty()) segs.push_back(seg);
            seg = Seg();
        };
        auto sameSegment = [&](int a, int b) {
            if (a == b) return true;
            const RunStyle& sa = resolved[a].run->style;
            const RunStyle& sb = resolved[b].run->style;

            return resolved[a].font == resolved[b].font &&
                   resolved[a].cidFont == resolved[b].cidFont &&
                   resolved[a].emitSize == resolved[b].emitSize &&
                   resolved[a].baseShift == resolved[b].baseShift &&
                   resolved[a].hScale == resolved[b].hScale && sa.rgba == sb.rgba &&
                   sa.underline == sb.underline && sa.strike == sb.strike &&
                   sa.renderMode == sb.renderMode &&
                   (!sa.strokes() ||
                    (sa.strokeRgba == sb.strokeRgba && sa.strokeWidth == sb.strokeWidth));
        };
        auto appendCid = [&](int ri, uint32_t cid, float advance, float xOff) {
            if (seg.text.empty() && seg.cids.empty()) {
                seg.runIndex = ri;
                seg.complex = true;
                seg.startX = cx + xOff;
            } else if (!seg.complex || !sameSegment(seg.runIndex, ri)) {
                flushSeg();
                seg.runIndex = ri;
                seg.complex = true;
                seg.startX = cx + xOff;
            }
            if (!seg.cids.empty()) seg.positions.push_back(cx + xOff - seg.startX);
            seg.cids.push_back(cid);
            cx += advance;
            seg.width = cx - seg.startX;
        };
        auto appendChar = [&](uint32_t cp, int ri, float advance) {
            if (seg.text.empty() && seg.cids.empty()) {
                seg.runIndex = ri;
                seg.startX = cx;
            } else if (seg.complex || !sameSegment(seg.runIndex, ri)) {
                flushSeg();
                seg.runIndex = ri;
                seg.startX = cx;
            }

            if (!seg.text.empty()) seg.positions.push_back(cx - seg.startX);
            appendCodepointUtf16(seg.text, cp);
            cx += advance;
            seg.width = cx - seg.startX;
        };

        std::vector<const Token*> emitTokens(ln.tokens.begin(), ln.tokens.end());
        auto emitComplexGlyph = [&](const ResolvedRun& rr, uint32_t cid,
                                    float x, float y) {
            FPDF_PAGEOBJECT obj =
                FPDFPageObj_CreateTextObj(s.doc, rr.cidFont, rr.emitSize);
            if (!obj) return;
            uint32_t one = cid;
            if (!FPDFText_SetCharcodes(obj, &one, 1)) {
                FPDFPageObj_Destroy(obj);
                return;
            }
            const RunStyle& st = rr.run->style;
            FS_MATRIX m{rr.hScale, 0, st.fauxItalic ? 0.2126f : 0.0f, 1, x, y};
            FPDFPageObj_SetMatrix(obj, &m);
            FPDFPageObj_SetFillColor(obj, (st.rgba >> 24) & 0xFF,
                                     (st.rgba >> 16) & 0xFF, (st.rgba >> 8) & 0xFF,
                                     st.rgba & 0xFF);
            if (st.fauxBold && !st.strokes()) {
                FPDFTextObj_SetTextRenderMode(obj,
                                              FPDF_TEXTRENDERMODE_FILL_STROKE);
                FPDFPageObj_SetStrokeColor(obj, (st.rgba >> 24) & 0xFF,
                                           (st.rgba >> 16) & 0xFF,
                                           (st.rgba >> 8) & 0xFF, st.rgba & 0xFF);
                FPDFPageObj_SetStrokeWidth(
                    obj, std::max(0.25f, 0.03f * rr.emitSize));
            }
            applyMarks(obj);
            insertObject(obj);
        };
        {
            uint8_t maxL = 0;
            bool anyOdd = false;
            for (const Token* t : emitTokens) {
                maxL = std::max(maxL, t->level);
                anyOdd |= (t->level & 1) != 0;
            }
            if (anyOdd) {
                for (int lev = maxL; lev >= 1; lev--) {
                    size_t st = 0;
                    while (st < emitTokens.size()) {
                        if (emitTokens[st]->level < lev) {
                            st++;
                            continue;
                        }
                        size_t en = st;
                        while (en < emitTokens.size() &&
                               emitTokens[en]->level >= lev)
                            en++;
                        std::reverse(emitTokens.begin() + static_cast<long>(st),
                                     emitTokens.begin() + static_cast<long>(en));
                        st = en;
                    }
                }
            }
        }
        auto emitChar = [&](uint32_t cp, int ri, float srcAdvOv = -1.0f) {

            uint32_t emitCp = cp;
            if (cp == 0x00A0) {
                float w = 0;
                if (!FPDFFont_GetGlyphWidth(resolved[ri].font, cp,
                                            resolved[ri].emitSize, &w) ||
                    w <= 0.001f) {
                    emitCp = u' ';
                }
            }
            if (emitCp == u' ' && !fontHasRealSpace(resolved[ri].font)) {
                cx += srcAdvOv >= 0 ? srcAdvOv : advanceOf(ri, cp);
                return;
            }
            appendChar(emitCp, ri,
                       srcAdvOv >= 0 ? srcAdvOv : advanceOf(ri, cp));
        };
        bool wordEmitted = false;
        for (const Token* t : emitTokens) {
            if (t->kind == Token::Space) {
                if (!wordEmitted && !paraRtl) {

                    cx += t->width;
                    continue;
                }
                int ri = t->runIndex;
                float adv = t->width + justifyExtra;

                const bool wouldOpenSeg =
                    (seg.text.empty() && seg.cids.empty()) ||
                    seg.complex != resolved[ri].complex ||
                    !sameSegment(seg.runIndex, ri);
                if (wouldOpenSeg) {
                    cx += adv;
                    continue;
                }
                ShapedEntry* se =
                    resolved[ri].complex ? shapedFor(ri, std::u16string(u" ")) : nullptr;
                if (se && se->g.size() == 1 && !se->cids.empty()) {
                    appendCid(ri, se->cids[0], adv, 0);
                } else if (resolved[ri].complex ||
                           !fontHasRealSpace(resolved[ri].font)) {
                    cx += adv;
                } else {
                    appendChar(u' ', ri, adv);
                }
            } else if (t->kind == Token::Word) {
                wordEmitted = true;

                if (t->chars.size() == 1 && t->chars[0].first == 0xFFFC &&
                    layoutRuns[static_cast<size_t>(t->chars[0].second)]
                        .atomicObject) {
                    flushSeg();
                    ParaRun& ar =
                        layoutRuns[static_cast<size_t>(t->chars[0].second)];
                    FS_MATRIX am;

                    if (objectStillOnPage(page, ar.atomicObject) &&
                        FPDFPageObj_GetMatrix(ar.atomicObject, &am)) {

                        const float adx = cx - ar.atomicX;
                        const float ady = baseline - ar.atomicBaseline;
                        am.e += prC * adx - prS * ady;
                        am.f += prS * adx + prC * ady;
                        FPDFPageObj_SetMatrix(ar.atomicObject, &am);

                        ar.atomicX = cx;
                        ar.atomicBaseline = baseline;
                    }
                    cx += t->width;
                    continue;
                }

                const bool rtlWord = (t->level & 1) != 0;
                if (tokenHasComplex(*t)) {

                    std::vector<std::pair<int, std::u16string>> vsegs;
                    wordSegsForEach(*t,
                                    [&](int ri, const std::u16string& sg) {
                                        vsegs.emplace_back(ri, sg);
                                    });
                    if (rtlWord) std::reverse(vsegs.begin(), vsegs.end());
                    for (auto& [ri, segText] : vsegs) {
                        const ResolvedRun& rr = resolved[ri];
                        ShapedEntry* e = rr.complex ? shapedFor(ri, segText) : nullptr;
                        if (e && !e->cids.empty() && rr.cidFont) {
                            const float kS = rr.emitSize / 1000.0f;
                            for (size_t gi = 0; gi < e->g.size(); gi++) {
                                const ShapedGlyph& g = e->g[gi];
                                const float advPt =
                                    (g.advance * kS + charSpacing) * rr.hScale;
                                const float gdx = g.dx * kS * rr.hScale;
                                const float gdy = g.dy * kS;
                                if (gdy != 0.0f) {

                                    flushSeg();
                                    emitComplexGlyph(rr, e->cids[gi], cx + gdx,
                                                     baseline + rr.baseShift + gdy);
                                    cx += advPt;
                                } else {
                                    appendCid(ri, e->cids[gi], advPt, gdx);
                                }
                            }
                            continue;
                        }

                        std::vector<uint32_t> cps;
                        for (size_t k = 0; k < segText.size(); k++) {
                            uint32_t cp = segText[k];
                            if (cp >= 0xD800 && cp <= 0xDBFF &&
                                k + 1 < segText.size()) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) +
                                     (segText[k + 1] - 0xDC00);
                                k++;
                            }
                            cps.push_back(cp);
                        }
                        if (rtlWord) {
                            std::reverse(cps.begin(), cps.end());

                            for (uint32_t& c2 : cps) c2 = bidiMirrorCp(c2);
                        }
                        for (uint32_t cp : cps) emitChar(cp, ri);
                    }
                } else if (rtlWord) {
                    for (auto it2 = t->chars.rbegin(); it2 != t->chars.rend(); ++it2) {
                        emitChar(bidiMirrorCp(it2->first), it2->second);
                    }
                } else {
                    for (size_t k = 0; k < t->chars.size(); k++) {
                        emitChar(t->chars[k].first, t->chars[k].second,
                                 t->advs.empty() ? -1.0f : t->advs[k]);
                    }
                }
            }
        }
        if (ln.hyphenRun >= 0) {
            ShapedEntry* he = resolved[ln.hyphenRun].complex
                                  ? shapedFor(ln.hyphenRun, std::u16string(u"-"))
                                  : nullptr;
            if (he && !he->cids.empty()) {
                appendCid(ln.hyphenRun, he->cids[0],
                          advanceOf(ln.hyphenRun, u'-'), 0);
            } else {
                appendChar(u'-', ln.hyphenRun, advanceOf(ln.hyphenRun, u'-'));
            }
        }
        flushSeg();

        for (const Seg& sg : segs) {
            const ResolvedRun& rr = resolved[sg.runIndex];
            const RunStyle& st = rr.run->style;
            FPDF_PAGEOBJECT obj = FPDFPageObj_CreateTextObj(
                s.doc, sg.complex ? rr.cidFont : rr.font, rr.emitSize);
            if (!obj) continue;

            if (sg.complex) {
                if (!FPDFText_SetCharcodes(obj, sg.cids.data(), sg.cids.size())) {
                    FPDFPageObj_Destroy(obj);
                    continue;
                }
            } else {

                std::vector<uint32_t> codes;
                bool viaCodes = false;
                auto encIt = s.fontUniToCode.find(rr.font);
                if (encIt != s.fontUniToCode.end() && !sg.text.empty()) {
                    viaCodes = true;
                    codes.reserve(sg.text.size());
                    for (char16_t ch : sg.text) {
                        auto ci = encIt->second.find(ch);
                        if (ci != encIt->second.end()) {
                            codes.push_back(ci->second);
                            continue;
                        }
                        if (rr.run && rr.font == rr.run->originalFont) {
                            const uint32_t orig = takeOrigCode(rr.font, ch);
                            if (orig != 0xFFFFFFFFu) {
                                codes.push_back(orig);
                                continue;
                            }
                        }
                        const auto pk = std::make_pair(rr.font, ch);
                        auto pit = probeCache.find(pk);
                        if (pit == probeCache.end())
                            pit = probeCache.emplace(
                                pk, probeCharcode(s.doc, rr.font, ch)).first;

                        codes.push_back(pit->second);
                    }
                }

                bool placed = viaCodes &&
                    FPDFText_SetCharcodes(obj, codes.data(), codes.size());
                if (!placed) {
                    std::vector<unsigned short> wide(sg.text.begin(), sg.text.end());
                    wide.push_back(0);
                    if (!FPDFText_SetText(obj, wide.data())) {
                        FPDFPageObj_Destroy(obj);
                        continue;
                    }
                }
            }
            if (!sg.positions.empty()) {

                std::vector<float> pos = sg.positions;
                if (rr.hScale != 1.0f) {
                    for (float& v : pos) v /= rr.hScale;
                }
                FPDFText_SetPositions(obj, pos.data(), pos.size());
            }

            FS_MATRIX m{rr.hScale, 0,
                        st.fauxItalic ? 0.2126f : 0.0f, 1,
                        sg.startX, baseline + rr.baseShift};
            FPDFPageObj_SetMatrix(obj, &m);
            FPDFPageObj_SetFillColor(obj, (st.rgba >> 24) & 0xFF, (st.rgba >> 16) & 0xFF,
                                     (st.rgba >> 8) & 0xFF, st.rgba & 0xFF);
            if (st.renderMode > 0 && st.renderMode <= 7) {
                FPDFTextObj_SetTextRenderMode(
                    obj, static_cast<FPDF_TEXT_RENDERMODE>(st.renderMode));
            }
            if (st.strokes()) {
                FPDFPageObj_SetStrokeColor(obj, (st.strokeRgba >> 24) & 0xFF,
                                           (st.strokeRgba >> 16) & 0xFF,
                                           (st.strokeRgba >> 8) & 0xFF,
                                           st.strokeRgba & 0xFF);
                FPDFPageObj_SetStrokeWidth(obj, st.strokeWidth > 0 ? st.strokeWidth : 1.0f);
            } else if (st.fauxBold) {

                FPDFTextObj_SetTextRenderMode(obj,
                                              FPDF_TEXTRENDERMODE_FILL_STROKE);
                FPDFPageObj_SetStrokeColor(obj, (st.rgba >> 24) & 0xFF,
                                           (st.rgba >> 16) & 0xFF,
                                           (st.rgba >> 8) & 0xFF,
                                           st.rgba & 0xFF);
                FPDFPageObj_SetStrokeWidth(
                    obj, std::max(0.25f, 0.03f * rr.emitSize));
            }
            applyMarks(obj);
            insertObject(obj);

            const float dSize = st.size;
            if (st.underline || st.strike) {
                const float thickness = std::max(0.45f, dSize * 0.055f);
                if (st.underline) {
                    float y = baseline + rr.baseShift - dSize * 0.12f - thickness;
                    FPDF_PAGEOBJECT rect =
                        FPDFPageObj_CreateNewRect(sg.startX, y, sg.width, thickness);
                    if (rect) {
                        FPDFPath_SetDrawMode(rect, FPDF_FILLMODE_WINDING, 0);
                        FPDFPageObj_SetFillColor(rect, (st.rgba >> 24) & 0xFF,
                                                 (st.rgba >> 16) & 0xFF,
                                                 (st.rgba >> 8) & 0xFF, st.rgba & 0xFF);
                        markDecoration(rect);
                        insertObject(rect);
                    }
                }
                if (st.strike) {
                    float y = baseline + rr.baseShift + dSize * 0.27f;
                    FPDF_PAGEOBJECT rect =
                        FPDFPageObj_CreateNewRect(sg.startX, y, sg.width, thickness);
                    if (rect) {
                        FPDFPath_SetDrawMode(rect, FPDF_FILLMODE_WINDING, 0);
                        FPDFPageObj_SetFillColor(rect, (st.rgba >> 24) & 0xFF,
                                                 (st.rgba >> 16) & 0xFF,
                                                 (st.rgba >> 8) & 0xFF, st.rgba & 0xFF);
                        markDecoration(rect);
                        insertObject(rect);
                    }
                }
            }
        }

        float lineWidth = std::max(0.0f, cx - startX);

        long lineFlat = -1;
        {
            int fr2 = -1;
            size_t fo2 = 0;
            for (const Token* t : ln.tokens) {
                if (t->kind == Token::Word && !t->offs.empty()) {
                    fr2 = t->chars[0].second;
                    fo2 = t->offs[0];
                    break;
                }
                if (t->kind == Token::Space) {
                    fr2 = t->runIndex;
                    fo2 = t->off;
                    break;
                }
            }
            if (fr2 >= 0 && fr2 < static_cast<int>(p.runs.size())) {
                lineFlat = static_cast<long>(fo2);
                for (int ri2 = 0; ri2 < fr2; ri2++)
                    lineFlat += static_cast<long>(p.runs[static_cast<size_t>(ri2)].text.size());
            }
        }
        LineInfo li2{baseline, startX,
                     ln.endsHard || li + 1 == wrapped.size()
                         ? lineWidth
                         : std::max(lineWidth, p.width)};

        if (lineFlat < 0 && !p.lines.empty()) lineFlat = p.lines.back().off;

        li2.penX = startX;
        li2.hasPenX = !paraRtl && lineFlat >= 0;
        li2.off = lineFlat >= 0 ? lineFlat : 0;
        p.lines.push_back(li2);

        float descent = 0;
        for (const Token* t : ln.tokens) {
            if (t->kind != Token::Word) continue;
            for (auto& [c, ri] : t->chars) {
                descent = std::max(descent,
                                   fontDescent(resolved[ri].font, resolved[ri].run->style.size));
            }
        }
        lastDescent = descent > 0 ? descent : maxSize * 0.22f;
    }

    p.height = (p.top - baseline) + lastDescent;

    if (!previewJson) {
        unsigned int th = 5381;
        for (const auto& r : p.runs)
            for (char16_t c : r.text)
                if (c != u' ' && c != u'\t' && c != 0x00A0 && c != u'\n' &&
                    c != u'\r')
                    th = th * 33u + static_cast<unsigned int>(c);
        const OwnedObject* markTarget = nullptr;
        for (const auto& oo : p.objects) {
            if (!oo.object ||
                FPDFPageObj_GetType(oo.object) != FPDF_PAGEOBJ_TEXT)
                continue;
            if (!oo.preserved) { markTarget = &oo; break; }
            if (!markTarget) markTarget = &oo;
        }
        for (const auto* pt = markTarget; pt; pt = nullptr) {
            const OwnedObject& oo = *pt;

            for (int mi = FPDFPageObj_CountMarks(oo.object) - 1; mi >= 0; mi--) {
                FPDF_PAGEOBJECTMARK old2 = FPDFPageObj_GetMark(oo.object, mi);
                if (!old2) continue;
                unsigned long nn = 0;
                char16_t nb[16] = {0};
                if (FPDFPageObjMark_GetName(old2,
                                            reinterpret_cast<FPDF_WCHAR*>(nb),
                                            sizeof(nb), &nn) &&
                    utf16ToUtf8(std::u16string(nb)) == "ECFmt") {
                    FPDFPageObj_RemoveMark(oo.object, old2);
                }
            }
            FPDF_PAGEOBJECTMARK mk = FPDFPageObj_AddMark(oo.object, "ECFmt");
            if (mk) {
                char fb[220];
                snprintf(fb, sizeof(fb),
                         "1|a%d|ls%.4f|cs%.4f|ps%.3f|ws%.4f|fi%.2f|hi%.2f|"
                         "d%d|ll%d|h%08x",
                         p.fmt.align, p.fmt.line_spacing, p.fmt.char_spacing,
                         p.fmt.para_spacing, p.fmt.word_spacing,
                         p.fmt.first_indent, p.fmt.hang_indent, p.fmt.dir,
                         p.fmt.list_level, th);
                FPDFPageObjMark_SetStringParam(s.doc, oo.object, mk, "f", fb);
            }
        }
    }
    if (previewJson) {
        char head[220];

        snprintf(head, sizeof(head),
                 "{\"x\":%.3f,\"top\":%.3f,\"width\":%.3f,"
                 "\"height\":%.3f,\"firstBaseline\":%.3f,\"pinned\":%d,"
                 "\"pinWhy\":%d,\"srcAdv\":%d,\"lines\":[",
                 p.x, p.top, p.width, p.height, p.firstBaseline,
                 p.pinnedBreaks.empty() ? 0 : 1, p.pinWhy, srcAdvUsed);
        *previewJson = std::string(head) + previewLines + "]}";
    }

    p.pinnedBreaks.clear();
    return true;
}

}


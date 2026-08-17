#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>

#include "ec_internal.h"

namespace ec {
namespace {

constexpr float kUpm = 1000.0f;

struct Pt {
    int16_t x = 0, y = 0;
    bool on = true;
};
struct Contour {
    std::vector<Pt> pts;
};
struct Glyph {
    std::vector<Contour> contours;
    int adv = 0;
    int16_t xmin = 0, ymin = 0, xmax = 0, ymax = 0;
    bool hasInk() const { return !contours.empty(); }
};

int16_t clampF(float v) {
    if (v > 32000.0f) return 32000;
    if (v < -32000.0f) return -32000;
    return static_cast<int16_t>(std::lround(v));
}

void pushQuadForCubic(Contour& c, float x0, float y0, float x1, float y1,
                      float x2, float y2, float x3, float y3) {
    const float qx = (3.0f * (x1 + x2) - x0 - x3) * 0.25f;
    const float qy = (3.0f * (y1 + y2) - y0 - y3) * 0.25f;
    c.pts.push_back({clampF(qx), clampF(qy), false});
    c.pts.push_back({clampF(x3), clampF(y3), true});
}

void cubicToQuads(Contour& c, float x0, float y0, float x1, float y1,
                  float x2, float y2, float x3, float y3) {
    const float ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
    const float bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
    const float cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
    const float dx = (ax + bx) / 2, dy = (ay + by) / 2;
    const float ex = (bx + cx) / 2, ey = (by + cy) / 2;
    const float fx = (dx + ex) / 2, fy = (dy + ey) / 2;
    pushQuadForCubic(c, x0, y0, ax, ay, dx, dy, fx, fy);
    pushQuadForCubic(c, fx, fy, ex, ey, cx, cy, x3, y3);
}

void finishContour(Glyph& g, Contour& c) {
    if (c.pts.size() >= 2) {

        const Pt& f = c.pts.front();
        const Pt& l = c.pts.back();
        if (l.on && l.x == f.x && l.y == f.y) c.pts.pop_back();
    }
    if (c.pts.size() >= 2) g.contours.push_back(std::move(c));
    c = Contour();
}

float probeOutlineScale(FPDF_FONT font, const std::set<uint32_t>& want) {
    int probed = 0;
    float rawMax = 0;
    for (uint32_t cp : want) {
        if (cp <= 0x20 || cp > 0xFFFE) continue;
        FPDF_GLYPHPATH gp = FPDFFont_GetGlyphPath(font, cp, kUpm);
        if (!gp) continue;
        const int n = FPDFGlyphPath_CountGlyphSegments(gp);
        bool any = false;
        for (int i = 0; i < n; i++) {
            FPDF_PATHSEGMENT seg = FPDFGlyphPath_GetGlyphPathSegment(gp, i);
            if (!seg) continue;
            float x = 0, y = 0;
            FPDFPathSegment_GetPoint(seg, &x, &y);
            rawMax = std::max(rawMax, std::max(std::fabs(x), std::fabs(y)));
            any = true;
        }
        if (any && ++probed >= 5) break;
    }
    if (rawMax <= 0) return 1.0f;
    return rawMax < 10.0f ? kUpm : 1.0f;
}

bool extractGlyph(FPDF_FONT font, uint32_t cp, Glyph& g, float scl) {
    float w = 0;
    if (FPDFFont_GetGlyphWidth(font, cp, kUpm, &w)) g.adv = std::max(0, (int)std::lround(w));
    FPDF_GLYPHPATH gp = FPDFFont_GetGlyphPath(font, cp, kUpm);
    if (!gp) return g.adv > 0;
    const int n = FPDFGlyphPath_CountGlyphSegments(gp);
    Contour cur;
    float px = 0, py = 0;
    for (int i = 0; i < n; i++) {
        FPDF_PATHSEGMENT seg = FPDFGlyphPath_GetGlyphPathSegment(gp, i);
        if (!seg) continue;
        float x = 0, y = 0;
        FPDFPathSegment_GetPoint(seg, &x, &y);
        x *= scl; y *= scl;
        const int type = FPDFPathSegment_GetType(seg);
        if (type == FPDF_SEGMENT_MOVETO) {
            finishContour(g, cur);
            cur.pts.push_back({clampF(x), clampF(y), true});
            px = x; py = y;
        } else if (type == FPDF_SEGMENT_LINETO) {
            cur.pts.push_back({clampF(x), clampF(y), true});
            px = x; py = y;
        } else if (type == FPDF_SEGMENT_BEZIERTO) {

            if (i + 2 < n) {
                FPDF_PATHSEGMENT s2 = FPDFGlyphPath_GetGlyphPathSegment(gp, i + 1);
                FPDF_PATHSEGMENT s3 = FPDFGlyphPath_GetGlyphPathSegment(gp, i + 2);
                float x2 = 0, y2 = 0, x3 = 0, y3 = 0;
                if (s2 && s3) {
                    FPDFPathSegment_GetPoint(s2, &x2, &y2);
                    FPDFPathSegment_GetPoint(s3, &x3, &y3);
                    x2 *= scl; y2 *= scl; x3 *= scl; y3 *= scl;
                    cubicToQuads(cur, px, py, x, y, x2, y2, x3, y3);
                    px = x3; py = y3;
                    if (FPDFPathSegment_GetClose(s3)) finishContour(g, cur);
                    i += 2;
                    continue;
                }
            }
        }
        if (FPDFPathSegment_GetClose(seg)) finishContour(g, cur);
    }
    finishContour(g, cur);

    bool first = true;
    for (const auto& c : g.contours)
        for (const auto& p : c.pts) {
            if (first) { g.xmin = g.xmax = p.x; g.ymin = g.ymax = p.y; first = false; }
            g.xmin = std::min(g.xmin, p.x); g.xmax = std::max(g.xmax, p.x);
            g.ymin = std::min(g.ymin, p.y); g.ymax = std::max(g.ymax, p.y);
        }
    return true;
}

struct Buf {
    std::vector<uint8_t> b;
    void u8(uint8_t v) { b.push_back(v); }
    void u16(uint16_t v) { b.push_back(v >> 8); b.push_back(v & 0xff); }
    void i16(int16_t v) { u16(static_cast<uint16_t>(v)); }
    void u32(uint32_t v) {
        b.push_back(v >> 24); b.push_back((v >> 16) & 0xff);
        b.push_back((v >> 8) & 0xff); b.push_back(v & 0xff);
    }
    void raw(const void* p, size_t n) {
        const uint8_t* s = static_cast<const uint8_t*>(p);
        b.insert(b.end(), s, s + n);
    }
    void pad4() { while (b.size() % 4) b.push_back(0); }
    size_t size() const { return b.size(); }
};

uint32_t checksum(const std::vector<uint8_t>& d, size_t off, size_t len) {
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i += 4) {
        uint32_t v = 0;
        for (int k = 0; k < 4; k++)
            v = (v << 8) | (off + i + k < off + len ? d[off + i + k] : 0);
        sum += v;
    }
    return sum;
}

}

std::vector<uint8_t> synthesizeSfnt(FPDF_FONT font, const std::set<uint32_t>& want,
                                    const std::map<uint32_t, int>* expectedAdv,
                                    bool* dishonest, bool restricted,
                                    const std::string& family) {
    std::map<uint32_t, Glyph> glyphs;
    int inked = 0;
    int validated = 0, mismatched = 0;
    const float scl = probeOutlineScale(font, want);
    for (uint32_t cp : want) {
        if (cp > 0xFFFE) continue;
        Glyph g;
        if (!extractGlyph(font, cp, g, scl)) continue;

        if (expectedAdv) {
            auto ea = expectedAdv->find(cp);
            if (ea != expectedAdv->end() && g.adv > 0) {
                const int exp2 = ea->second;
                const int tol = std::max(80, exp2 / 4);
                validated++;
                if (std::abs(g.adv - exp2) > tol) {
                    mismatched++;
                    if (getenv("EC_SYNTH_DEBUG") && mismatched <= 6)
                        fprintf(stderr, "[synth] MISMATCH cp=U+%04X adv=%d exp=%d tol=%d\n",
                                cp, g.adv, exp2, tol);
                    continue;
                }
            }
        }

        if (expectedAdv) {
            auto ea2 = expectedAdv->find(cp);
            if (ea2 != expectedAdv->end() && ea2->second > 0 &&
                ea2->second <= 3000)
                g.adv = ea2->second;
        }

        if (g.hasInk() && g.adv == 0)
            g.adv = std::min(1000, g.xmax + std::max<int>(20, g.xmax / 10));
        if (g.hasInk()) inked++;

        const bool ws = cp == 0x20 || cp == 0xA0 || cp == 0x09;
        if (g.hasInk() || (ws && g.adv > 0)) glyphs.emplace(cp, std::move(g));
    }

    if (getenv("EC_SYNTH_DEBUG"))
        fprintf(stderr, "[synth] validated=%d mismatched=%d inked=%d restricted=%d\n",
                validated, mismatched, inked, restricted ? 1 : 0);
    if (dishonest &&
        (mismatched >= 2 || (validated > 0 && mismatched * 4 >= validated))) {
        *dishonest = true;
        return {};
    }

    if (dishonest && !restricted) {
        int dmin = INT_MAX, dmax = 0, dcount = 0;
        for (uint32_t d = u'0'; d <= u'9'; d++) {
            auto ig = glyphs.find(d);
            if (ig == glyphs.end() || !ig->second.hasInk() ||
                ig->second.adv <= 0)
                continue;
            dcount++;
            dmin = std::min(dmin, ig->second.adv);
            dmax = std::max(dmax, ig->second.adv);
        }
        if (dcount >= 2 && dmax - dmin > std::max(30, dmax / 12)) {
            if (getenv("EC_SYNTH_DEBUG"))
                fprintf(stderr, "[synth] digit-tabular reject: n=%d min=%d max=%d\n",
                        dcount, dmin, dmax);
            *dishonest = true;
            return {};
        }
    }
    if (!inked) return {};

    {
        std::map<std::string, int> shapeCount;
        auto shapeKey = [](const Glyph& g) {
            std::string k;
            k.reserve(g.contours.size() * 16);
            for (const auto& c : g.contours) {
                k += '|';
                for (const auto& pt : c.pts) {
                    k += std::to_string(pt.x);
                    k += ',';
                    k += std::to_string(pt.y);
                    k += pt.on ? ';' : '*';
                }
            }
            return k;
        };
        for (const auto& [cp, g] : glyphs)
            if (g.hasInk()) shapeCount[shapeKey(g)]++;
        for (auto it2 = glyphs.begin(); it2 != glyphs.end();) {
            if (it2->second.hasInk() && shapeCount[shapeKey(it2->second)] >= 4) {
                it2 = glyphs.erase(it2);
            } else {
                ++it2;
            }
        }
        inked = 0;
        for (const auto& [cp, g] : glyphs)
            if (g.hasInk()) inked++;
        if (!inked) return {};
    }

    std::vector<const Glyph*> order;
    std::vector<uint32_t> cps;
    Glyph notdef;
    notdef.adv = 500;
    order.push_back(&notdef);
    for (const auto& [cp, g] : glyphs) { order.push_back(&g); cps.push_back(cp); }
    const uint16_t numGlyphs = static_cast<uint16_t>(order.size());

    float fa = 800, fd = -200;
    FPDFFont_GetAscent(font, kUpm, &fa);
    FPDFFont_GetDescent(font, kUpm, &fd);
    const int16_t asc = clampF(std::max(fa, 1.0f));
    const int16_t desc = clampF(std::min(fd, -1.0f));

    Buf glyf;
    std::vector<uint32_t> loca;
    int16_t xminA = 0, yminA = 0, xmaxA = 0, ymaxA = 0;
    uint16_t maxPts = 0, maxCtr = 0;
    bool firstBox = true;
    for (const Glyph* g : order) {
        loca.push_back(static_cast<uint32_t>(glyf.size()));
        if (!g->hasInk()) continue;
        if (firstBox) { xminA = g->xmin; yminA = g->ymin; xmaxA = g->xmax; ymaxA = g->ymax; firstBox = false; }
        xminA = std::min(xminA, g->xmin); yminA = std::min(yminA, g->ymin);
        xmaxA = std::max(xmaxA, g->xmax); ymaxA = std::max(ymaxA, g->ymax);
        uint16_t npts = 0;
        for (const auto& c : g->contours) npts += c.pts.size();
        maxPts = std::max(maxPts, npts);
        maxCtr = std::max<uint16_t>(maxCtr, g->contours.size());
        glyf.i16(static_cast<int16_t>(g->contours.size()));
        glyf.i16(g->xmin); glyf.i16(g->ymin); glyf.i16(g->xmax); glyf.i16(g->ymax);
        uint16_t end = 0;
        for (size_t ci = 0; ci < g->contours.size(); ci++) {
            end += g->contours[ci].pts.size();
            glyf.u16(end - 1);
        }
        glyf.u16(0);
        for (const auto& c : g->contours)
            for (const auto& p : c.pts) glyf.u8(p.on ? 0x01 : 0x00);
        int16_t prev = 0;
        for (const auto& c : g->contours)
            for (const auto& p : c.pts) { glyf.i16(p.x - prev); prev = p.x; }
        prev = 0;
        for (const auto& c : g->contours)
            for (const auto& p : c.pts) { glyf.i16(p.y - prev); prev = p.y; }
        glyf.pad4();
    }
    loca.push_back(static_cast<uint32_t>(glyf.size()));

    Buf locaT;
    for (uint32_t off : loca) locaT.u32(off);

    struct Seg { uint32_t start, end; uint16_t gidStart; };
    std::vector<Seg> segs;
    for (size_t i = 0; i < cps.size(); i++) {
        if (!segs.empty() && cps[i] == segs.back().end + 1) segs.back().end = cps[i];
        else segs.push_back({cps[i], cps[i], static_cast<uint16_t>(i + 1)});
    }
    Buf sub;
    const uint16_t segCount = static_cast<uint16_t>(segs.size() + 1);
    uint16_t pow2 = 1, entSel = 0;
    while (pow2 * 2 <= segCount) { pow2 *= 2; entSel++; }
    const uint16_t sr = pow2 * 2;
    sub.u16(4);
    sub.u16(static_cast<uint16_t>(16 + segCount * 8));
    sub.u16(0);
    sub.u16(segCount * 2);
    sub.u16(sr);
    sub.u16(entSel);
    sub.u16(segCount * 2 - sr);
    for (const Seg& s : segs) sub.u16(static_cast<uint16_t>(s.end));
    sub.u16(0xFFFF);
    sub.u16(0);
    for (const Seg& s : segs) sub.u16(static_cast<uint16_t>(s.start));
    sub.u16(0xFFFF);
    for (const Seg& s : segs)
        sub.u16(static_cast<uint16_t>((s.gidStart - s.start) & 0xFFFF));
    sub.u16(1);
    for (size_t i = 0; i < segs.size() + 1; i++) sub.u16(0);
    Buf cmap;
    cmap.u16(0); cmap.u16(1);
    cmap.u16(3); cmap.u16(1); cmap.u32(12);
    cmap.raw(sub.b.data(), sub.b.size());

    Buf hmtx;
    uint16_t advMax = 0;
    for (const Glyph* g : order) {
        hmtx.u16(static_cast<uint16_t>(std::min(g->adv, 65535)));
        hmtx.i16(g->hasInk() ? g->xmin : 0);
        advMax = std::max(advMax, static_cast<uint16_t>(std::min(g->adv, 65535)));
    }
    Buf hhea;
    hhea.u32(0x00010000);
    hhea.i16(asc); hhea.i16(desc); hhea.i16(0);
    hhea.u16(advMax);
    hhea.i16(xminA);
    hhea.i16(static_cast<int16_t>(xminA));
    hhea.i16(xmaxA);
    hhea.i16(1); hhea.i16(0);
    hhea.i16(0);
    for (int i = 0; i < 4; i++) hhea.i16(0);
    hhea.i16(0);
    hhea.u16(numGlyphs);

    Buf head;
    head.u32(0x00010000);
    head.u32(0x00010000);
    head.u32(0);
    head.u32(0x5F0F3CF5);
    head.u16(0x0003);
    head.u16(static_cast<uint16_t>(kUpm));
    head.u32(0); head.u32(0);
    head.u32(0); head.u32(0);
    head.i16(xminA); head.i16(yminA); head.i16(xmaxA); head.i16(ymaxA);
    head.u16(0);
    head.u16(6);
    head.i16(2);
    head.i16(1);
    head.i16(0);

    Buf maxp;
    maxp.u32(0x00010000);
    maxp.u16(numGlyphs);
    maxp.u16(maxPts); maxp.u16(maxCtr);
    maxp.u16(0); maxp.u16(0);
    maxp.u16(2); maxp.u16(0);
    maxp.u16(0); maxp.u16(0); maxp.u16(0);
    maxp.u16(0); maxp.u16(0);
    maxp.u16(0); maxp.u16(0);

    Buf os2;
    os2.u16(1);
    os2.i16(static_cast<int16_t>(advMax / 2));
    os2.u16(400); os2.u16(5);
    os2.u16(0);

    for (int i = 0; i < 5; i++) { os2.i16(650); os2.i16(325); }
    os2.i16(0);
    for (int i = 0; i < 10; i++) os2.u8(0);
    os2.u32(0); os2.u32(0); os2.u32(0); os2.u32(0);
    os2.raw("ECEC", 4);
    os2.u16(0x0040);
    os2.u16(static_cast<uint16_t>(cps.front()));
    os2.u16(static_cast<uint16_t>(std::min<uint32_t>(cps.back(), 0xFFFF)));
    os2.i16(asc); os2.i16(desc); os2.i16(90);
    os2.u16(static_cast<uint16_t>(asc));
    os2.u16(static_cast<uint16_t>(-desc));
    os2.u32(0); os2.u32(0);

    std::string famName = family.empty() ? "EC Synth" : family;
    if (famName.size() > 60) famName.resize(60);
    const size_t nameLen = famName.size() * 2;
    Buf nameStr;
    for (char c : famName)
        nameStr.u16(static_cast<uint16_t>(static_cast<unsigned char>(c)));
    static const char16_t kStyle[] = u"Regular";
    Buf styleStr;
    for (size_t i = 0; i < 7; i++) styleStr.u16(kStyle[i]);
    const uint16_t nameIds[] = {1, 2, 3, 4, 6};
    Buf name;
    name.u16(0);
    name.u16(5);
    name.u16(static_cast<uint16_t>(6 + 5 * 12));
    uint16_t strOff = 0;
    for (uint16_t id : nameIds) {
        const bool style = (id == 2);
        const uint16_t len =
            style ? 14 : static_cast<uint16_t>(nameLen);
        name.u16(3); name.u16(1); name.u16(0x0409);
        name.u16(id); name.u16(len); name.u16(style ? static_cast<uint16_t>(nameLen) : 0);
        (void)strOff;
    }
    name.raw(nameStr.b.data(), nameStr.b.size());
    name.raw(styleStr.b.data(), styleStr.b.size());

    Buf post;
    post.u32(0x00030000);
    post.u32(0);
    post.i16(-75); post.i16(50);
    post.u32(0);
    post.u32(0); post.u32(0); post.u32(0); post.u32(0);

    struct Tab { const char* tag; Buf* buf; };
    Tab tabs[] = {
        {"OS/2", &os2}, {"cmap", &cmap}, {"glyf", &glyf}, {"head", &head},
        {"hhea", &hhea}, {"hmtx", &hmtx}, {"loca", &locaT}, {"maxp", &maxp},
        {"name", &name}, {"post", &post},
    };
    const uint16_t numTables = 10;
    uint16_t esr = 1, ees = 0;
    while (esr * 2 <= numTables) { esr *= 2; ees++; }
    Buf font_out;
    font_out.u32(0x00010000);
    font_out.u16(numTables);
    font_out.u16(esr * 16);
    font_out.u16(ees);
    font_out.u16((numTables - esr) * 16);
    size_t off = 12 + numTables * 16;
    size_t headOffset = 0;
    struct Placed { size_t off, len; };
    std::vector<Placed> placed;
    for (const Tab& t : tabs) {
        t.buf->pad4();
        placed.push_back({off, t.buf->size()});
        off += t.buf->size();
    }
    for (size_t i = 0; i < numTables; i++) {
        font_out.raw(tabs[i].tag, 4);
        font_out.u32(checksum(tabs[i].buf->b, 0, tabs[i].buf->size()));
        font_out.u32(static_cast<uint32_t>(placed[i].off));
        font_out.u32(static_cast<uint32_t>(placed[i].len));
        if (std::strncmp(tabs[i].tag, "head", 4) == 0) headOffset = placed[i].off;
    }
    for (size_t i = 0; i < numTables; i++)
        font_out.raw(tabs[i].buf->b.data(), tabs[i].buf->size());

    const uint32_t whole = checksum(font_out.b, 0, font_out.size());
    const uint32_t adj = 0xB1B0AFBAu - whole;
    font_out.b[headOffset + 8] = adj >> 24;
    font_out.b[headOffset + 9] = (adj >> 16) & 0xff;
    font_out.b[headOffset + 10] = (adj >> 8) & 0xff;
    font_out.b[headOffset + 11] = adj & 0xff;
    return std::move(font_out.b);
}

std::vector<uint8_t> buildCidEmissionFont(const uint8_t* srcFont, size_t srcSize,
                                          const std::vector<CidGlyphEntry>& entries,
                                          const std::string& familyName) {
    if (entries.empty()) return {};

    std::map<uint32_t, Glyph> shapeByGid;
    auto glyphFor = [&](uint32_t gid) -> const Glyph* {
        auto it = shapeByGid.find(gid);
        if (it != shapeByGid.end()) return &it->second;
        std::vector<std::vector<OutlinePt>> cont;
        Glyph g;
        if (hbGlyphContours(srcFont, srcSize, gid, cont)) {
            for (const auto& c : cont) {
                Contour cc;
                for (const auto& pt : c) cc.pts.push_back({clampF(pt.x), clampF(pt.y), pt.on});
                if (cc.pts.size() >= 2) {
                    const Pt& f0 = cc.pts.front();
                    const Pt& l0 = cc.pts.back();
                    if (l0.on && l0.x == f0.x && l0.y == f0.y) cc.pts.pop_back();
                }
                if (cc.pts.size() >= 2) g.contours.push_back(std::move(cc));
            }
        }
        bool first = true;
        for (const auto& c : g.contours)
            for (const auto& p2 : c.pts) {
                if (first) { g.xmin = g.xmax = p2.x; g.ymin = g.ymax = p2.y; first = false; }
                g.xmin = std::min(g.xmin, p2.x); g.xmax = std::max(g.xmax, p2.x);
                g.ymin = std::min(g.ymin, p2.y); g.ymax = std::max(g.ymax, p2.y);
            }
        return &shapeByGid.emplace(gid, std::move(g)).first->second;
    };

    const uint16_t numGlyphs = static_cast<uint16_t>(entries.size() + 1);
    Buf glyf;
    std::vector<uint32_t> loca;
    int16_t xminA = 0, yminA = 0, xmaxA = 0, ymaxA = 0;
    uint16_t maxPts = 0, maxCtr = 0;
    bool firstBox = true;
    loca.push_back(0);
    for (const auto& en : entries) {
        loca.push_back(static_cast<uint32_t>(glyf.size()));
        const Glyph* g = glyphFor(en.srcGid);
        if (!g->hasInk()) continue;
        if (firstBox) { xminA = g->xmin; yminA = g->ymin; xmaxA = g->xmax; ymaxA = g->ymax; firstBox = false; }
        xminA = std::min(xminA, g->xmin); yminA = std::min(yminA, g->ymin);
        xmaxA = std::max(xmaxA, g->xmax); ymaxA = std::max(ymaxA, g->ymax);
        uint16_t npts = 0;
        for (const auto& c : g->contours) npts += c.pts.size();
        maxPts = std::max(maxPts, npts);
        maxCtr = std::max<uint16_t>(maxCtr, g->contours.size());
        glyf.i16(static_cast<int16_t>(g->contours.size()));
        glyf.i16(g->xmin); glyf.i16(g->ymin); glyf.i16(g->xmax); glyf.i16(g->ymax);
        uint16_t end = 0;
        for (size_t ci = 0; ci < g->contours.size(); ci++) {
            end += g->contours[ci].pts.size();
            glyf.u16(end - 1);
        }
        glyf.u16(0);
        for (const auto& c : g->contours)
            for (const auto& p2 : c.pts) glyf.u8(p2.on ? 0x01 : 0x00);
        int16_t prev = 0;
        for (const auto& c : g->contours)
            for (const auto& p2 : c.pts) { glyf.i16(p2.x - prev); prev = p2.x; }
        prev = 0;
        for (const auto& c : g->contours)
            for (const auto& p2 : c.pts) { glyf.i16(p2.y - prev); prev = p2.y; }
        glyf.pad4();
    }
    loca.push_back(static_cast<uint32_t>(glyf.size()));

    Buf locaT;
    for (uint32_t off : loca) locaT.u32(off);

    Buf sub;
    sub.u16(4); sub.u16(24); sub.u16(0);
    sub.u16(2); sub.u16(2); sub.u16(0); sub.u16(0);
    sub.u16(0xFFFF); sub.u16(0);
    sub.u16(0xFFFF);
    sub.u16(1);
    sub.u16(0);
    Buf cmap;
    cmap.u16(0); cmap.u16(1);
    cmap.u16(3); cmap.u16(1); cmap.u32(12);
    cmap.raw(sub.b.data(), sub.b.size());

    Buf hmtx;
    uint16_t advMax = 0;
    hmtx.u16(500); hmtx.i16(0);
    for (const auto& en : entries) {
        const uint16_t a = static_cast<uint16_t>(
            std::min(65535L, std::max(0L, std::lround(en.advance))));
        const Glyph* g = glyphFor(en.srcGid);
        hmtx.u16(a);
        hmtx.i16(g->hasInk() ? g->xmin : 0);
        advMax = std::max(advMax, a);
    }
    Buf hhea;
    hhea.u32(0x00010000);
    hhea.i16(900); hhea.i16(-300); hhea.i16(0);
    hhea.u16(advMax);
    hhea.i16(xminA); hhea.i16(xminA); hhea.i16(xmaxA);
    hhea.i16(1); hhea.i16(0); hhea.i16(0);
    for (int i = 0; i < 4; i++) hhea.i16(0);
    hhea.i16(0);
    hhea.u16(numGlyphs);

    Buf head;
    head.u32(0x00010000);
    head.u32(0x00010000);
    head.u32(0);
    head.u32(0x5F0F3CF5);
    head.u16(0x0003);
    head.u16(1000);
    head.u32(0); head.u32(0); head.u32(0); head.u32(0);
    head.i16(xminA); head.i16(yminA); head.i16(xmaxA); head.i16(ymaxA);
    head.u16(0);
    head.u16(6);
    head.i16(2);
    head.i16(1);
    head.i16(0);

    Buf maxp;
    maxp.u32(0x00010000);
    maxp.u16(numGlyphs);
    maxp.u16(maxPts); maxp.u16(maxCtr);
    maxp.u16(0); maxp.u16(0);
    maxp.u16(2); maxp.u16(0);
    maxp.u16(0); maxp.u16(0); maxp.u16(0);
    maxp.u16(0); maxp.u16(0);
    maxp.u16(0); maxp.u16(0);

    Buf os2;
    os2.u16(1);
    os2.i16(static_cast<int16_t>(advMax / 2));
    os2.u16(400); os2.u16(5);
    os2.u16(0);
    for (int i = 0; i < 5; i++) { os2.i16(650); os2.i16(325); }
    os2.i16(0);
    for (int i = 0; i < 10; i++) os2.u8(0);
    os2.u32(0); os2.u32(0); os2.u32(0); os2.u32(0);
    os2.raw("ECEC", 4);
    os2.u16(0x0040);
    os2.u16(0x0020);
    os2.u16(0xFFFD);
    os2.i16(900); os2.i16(-300); os2.i16(90);
    os2.u16(900); os2.u16(300);
    os2.u32(0); os2.u32(0);

    std::string fam = familyName.empty() ? "EC Shaped" : familyName;
    if (fam.size() > 60) fam.resize(60);
    Buf nameStr;
    for (char c : fam) nameStr.u16(static_cast<uint16_t>(static_cast<unsigned char>(c)));
    static const char16_t kStyle[] = u"Regular";
    Buf styleStr;
    for (size_t i = 0; i < 7; i++) styleStr.u16(kStyle[i]);
    const uint16_t famLen = static_cast<uint16_t>(fam.size() * 2);
    const uint16_t nameIds[] = {1, 2, 3, 4, 6};
    Buf name;
    name.u16(0);
    name.u16(5);
    name.u16(static_cast<uint16_t>(6 + 5 * 12));
    for (uint16_t id : nameIds) {
        const bool style = (id == 2);
        name.u16(3); name.u16(1); name.u16(0x0409);
        name.u16(id);
        name.u16(style ? 14 : famLen);
        name.u16(style ? famLen : 0);
    }
    name.raw(nameStr.b.data(), nameStr.b.size());
    name.raw(styleStr.b.data(), styleStr.b.size());

    Buf post;
    post.u32(0x00030000);
    post.u32(0);
    post.i16(-75); post.i16(50);
    post.u32(0);
    post.u32(0); post.u32(0); post.u32(0); post.u32(0);

    struct Tab { const char* tag; Buf* buf; };
    Tab tabs[] = {
        {"OS/2", &os2}, {"cmap", &cmap}, {"glyf", &glyf}, {"head", &head},
        {"hhea", &hhea}, {"hmtx", &hmtx}, {"loca", &locaT}, {"maxp", &maxp},
        {"name", &name}, {"post", &post},
    };
    const uint16_t numTables = 10;
    uint16_t esr = 1, ees = 0;
    while (esr * 2 <= numTables) { esr *= 2; ees++; }
    Buf font_out;
    font_out.u32(0x00010000);
    font_out.u16(numTables);
    font_out.u16(esr * 16);
    font_out.u16(ees);
    font_out.u16((numTables - esr) * 16);
    size_t off = 12 + numTables * 16;
    size_t headOffset = 0;
    struct Placed { size_t off, len; };
    std::vector<Placed> placed;
    for (const Tab& t : tabs) {
        t.buf->pad4();
        placed.push_back({off, t.buf->size()});
        off += t.buf->size();
    }
    for (size_t i = 0; i < numTables; i++) {
        font_out.raw(tabs[i].tag, 4);
        font_out.u32(checksum(tabs[i].buf->b, 0, tabs[i].buf->size()));
        font_out.u32(static_cast<uint32_t>(placed[i].off));
        font_out.u32(static_cast<uint32_t>(placed[i].len));
        if (std::strncmp(tabs[i].tag, "head", 4) == 0) headOffset = placed[i].off;
    }
    for (size_t i = 0; i < numTables; i++)
        font_out.raw(tabs[i].buf->b.data(), tabs[i].buf->size());
    const uint32_t whole = checksum(font_out.b, 0, font_out.size());
    const uint32_t adj = 0xB1B0AFBAu - whole;
    font_out.b[headOffset + 8] = adj >> 24;
    font_out.b[headOffset + 9] = (adj >> 16) & 0xff;
    font_out.b[headOffset + 10] = (adj >> 8) & 0xff;
    font_out.b[headOffset + 11] = adj & 0xff;
    return std::move(font_out.b);
}

}

extern "C" {

unsigned char* ec_synth_run_font(EC_SESSION session, FPDF_PAGE page,
                                 int para_id, int run_index,
                                 unsigned long* out_size) {
    using namespace ec;
    if (out_size) *out_size = 0;
    Session* s = static_cast<Session*>(session);
    if (!s || !page || !out_size) return nullptr;
    auto it = s->pages.find(page);
    if (it == s->pages.end()) return nullptr;
    Paragraph* p = it->second.find(para_id);
    if (!p || run_index < 0 || run_index >= static_cast<int>(p->runs.size()))
        return nullptr;
    const ParaRun& run = p->runs[static_cast<size_t>(run_index)];
    if (!run.originalFont) return nullptr;

    std::map<uint32_t, int> expected;
    std::set<uint32_t> pageChars;
    auto sampleRun = [&](const ParaRun& r) {
        for (size_t i = 0; i < r.text.size(); i++) {
            char16_t c = r.text[i];
            if (c >= 0xD800 && c <= 0xDBFF && i + 1 < r.text.size()) {
                const char16_t lo = r.text[i + 1];
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    pageChars.insert(0x10000 + ((c - 0xD800) << 10) +
                                     (lo - 0xDC00));
                    i++;
                    continue;
                }
            }
            if (c >= 0x20 && !isUndecodableChar(c))
                pageChars.insert(static_cast<uint32_t>(c));
        }
        if (r.style.size <= 0.5f || r.srcAdv.size() != r.text.size()) return;
        const float hs = r.style.hScale > 0.01f ? r.style.hScale : 1.0f;
        for (size_t i = 0; i < r.text.size(); i++) {
            const char16_t c = r.text[i];
            if (c >= 0xD800 && c <= 0xDFFF) continue;
            const float a = r.srcAdv[i];
            if (a <= 0) continue;

            if ((i > 0 && r.srcAdv[i - 1] <= 0) ||
                (i + 1 < r.text.size() && r.srcAdv[i + 1] <= 0))
                continue;

            if (i + 1 < r.text.size()) {
                const char16_t nx = r.text[i + 1];
                if (nx == u' ' || nx == u'\t' || nx == u'\n' || nx == 0x00A0)
                    continue;
            } else {
                continue;
            }
            const int em = static_cast<int>(
                std::lround(a / (r.style.size * hs) * 1000.0f));
            if (em > 0) expected.emplace(static_cast<uint32_t>(c), em);
        }
    };
    for (const Paragraph& q : it->second.paras)
        for (const ParaRun& r : q.runs)
            if (r.originalFont == run.originalFont) sampleRun(r);

    std::set<uint32_t> want = pageChars;
    for (uint32_t c = 0x20; c < 0x7F; c++) want.insert(c);
    bool dishonest = false;
    std::vector<uint8_t> bytes =
        synthesizeSfnt(run.originalFont, want,
                       expected.empty() ? nullptr : &expected, &dishonest);
    if (dishonest && !pageChars.empty()) {

        dishonest = false;
        bytes = synthesizeSfnt(run.originalFont, pageChars,
                               expected.empty() ? nullptr : &expected,
                               &dishonest,  true);
    }
    if (dishonest) {

        unsigned char* flag = static_cast<unsigned char*>(malloc(1));
        if (!flag) return nullptr;
        flag[0] = 0xDD;
        *out_size = 1;
        return flag;
    }
    if (bytes.empty()) return nullptr;
    unsigned char* out = static_cast<unsigned char*>(malloc(bytes.size()));
    if (!out) return nullptr;
    std::memcpy(out, bytes.data(), bytes.size());
    *out_size = bytes.size();
    return out;
}

}


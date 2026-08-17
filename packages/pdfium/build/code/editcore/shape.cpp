#include <cstring>
#include <map>

#include "ec_internal.h"
#include "hb-ot.h"
#include "hb-subset.h"
#include "hb.h"

namespace ec {

namespace {

struct HbFontEntry {
    hb_blob_t* blob = nullptr;
    hb_face_t* face = nullptr;
    hb_font_t* font = nullptr;
    unsigned upem = 1000;
};
std::map<const uint8_t*, HbFontEntry>& hbCache() {
    static std::map<const uint8_t*, HbFontEntry> c;
    return c;
}

HbFontEntry* hbFontFor(const uint8_t* data, size_t size) {
    auto& cache = hbCache();
    auto it = cache.find(data);
    if (it != cache.end()) return &it->second;
    HbFontEntry e;
    e.blob = hb_blob_create(reinterpret_cast<const char*>(data),
                            static_cast<unsigned>(size), HB_MEMORY_MODE_READONLY,
                            nullptr, nullptr);
    e.face = hb_face_create(e.blob, 0);
    if (!e.face || hb_face_get_glyph_count(e.face) == 0) {
        hb_face_destroy(e.face);
        hb_blob_destroy(e.blob);
        return nullptr;
    }
    e.upem = hb_face_get_upem(e.face);
    if (!e.upem) e.upem = 1000;
    e.font = hb_font_create(e.face);
    hb_font_set_scale(e.font, static_cast<int>(e.upem), static_cast<int>(e.upem));
    auto res = cache.emplace(data, e);
    return &res.first->second;
}

}

bool cpNeedsComplexShaping(uint32_t cp) {
    return (cp >= 0x0900 && cp <= 0x0DFF) ||
           (cp >= 0x0E00 && cp <= 0x0EFF) ||
           (cp >= 0x1000 && cp <= 0x109F) ||
           (cp >= 0x1780 && cp <= 0x17FF);
}

bool textNeedsComplexShaping(const std::u16string& t) {
    for (char16_t c : t)
        if (cpNeedsComplexShaping(c)) return true;
    return false;
}

bool hbShapeText(const uint8_t* fontData, size_t fontSize,
                 const std::u16string& text, std::vector<ShapedGlyph>& out) {
    out.clear();
    if (!fontData || !fontSize || text.empty()) return false;
    HbFontEntry* e = hbFontFor(fontData, fontSize);
    if (!e || !e->font) return false;

    hb_buffer_t* buf = hb_buffer_create();
    hb_buffer_add_utf16(buf, reinterpret_cast<const uint16_t*>(text.c_str()),
                        static_cast<int>(text.size()), 0,
                        static_cast<int>(text.size()));
    hb_buffer_guess_segment_properties(buf);
    hb_shape(e->font, buf, nullptr, 0);

    unsigned n = 0;
    hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &n);
    hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &n);
    const float k = 1000.0f / static_cast<float>(e->upem);
    out.reserve(n);
    for (unsigned i = 0; i < n; i++) {
        ShapedGlyph g;
        g.gid = info[i].codepoint;
        g.cluster = info[i].cluster;
        g.advance = pos[i].x_advance * k;
        g.dx = pos[i].x_offset * k;
        g.dy = pos[i].y_offset * k;
        out.push_back(g);
    }
    hb_buffer_destroy(buf);
    return !out.empty();
}

bool hbShapesCleanly(const uint8_t* fontData, size_t fontSize,
                     const std::u16string& text, bool requireInk) {
    std::u16string probe;
    probe.reserve(text.size());
    for (char16_t c : text) {
        if (c <= 0x0020 || c == 0x00A0 || c == 0x00AD || c == 0x061C ||
            (c >= 0x200B && c <= 0x200F) || c == 0x2028 || c == 0x2029 ||
            c == 0xFEFF)
            continue;
        probe.push_back(c);
    }
    if (probe.empty()) return true;
    std::vector<ShapedGlyph> glyphs;
    if (!hbShapeText(fontData, fontSize, probe, glyphs)) return false;
    HbFontEntry* e = hbFontFor(fontData, fontSize);
    for (const auto& g : glyphs) {
        if (g.gid == 0) return false;

        if (requireInk && e && e->font) {
            hb_glyph_extents_t ext = {};
            if (hb_font_get_glyph_extents(e->font, g.gid, &ext) &&
                ext.width == 0 && ext.height == 0)
                return false;
        }
    }
    return true;
}

bool hbFontShapesArabic(const uint8_t* fontData, size_t fontSize) {
    std::vector<ShapedGlyph> glyphs;
    if (!hbShapeText(fontData, fontSize, std::u16string(u"بب"),
                     glyphs) ||
        glyphs.size() != 2)
        return false;
    return glyphs[0].gid != 0 && glyphs[1].gid != 0 &&
           glyphs[0].gid != glyphs[1].gid;
}

std::u16string hbGlyphNameText(const uint8_t* fontData, size_t fontSize,
                               uint32_t gid) {
    std::u16string out;
    if (!fontData || !fontSize) return out;
    HbFontEntry* e = hbFontFor(fontData, fontSize);
    if (!e || !e->font) return out;
    char name[128] = {0};
    if (!hb_font_get_glyph_name(e->font, gid, name, sizeof(name)) || !name[0])
        return out;
    std::string n(name);
    const size_t dot = n.find('.');
    if (dot != std::string::npos) n.resize(dot);
    if (n.empty()) return out;

    auto hexRun = [](const std::string& s, size_t at, size_t len,
                     uint32_t* cp) {
        if (at + len > s.size()) return false;
        uint32_t v = 0;
        for (size_t k = 0; k < len; k++) {
            const char c = s[at + k];
            const int d = (c >= '0' && c <= '9')   ? c - '0'
                          : (c >= 'A' && c <= 'F') ? c - 'A' + 10
                          : (c >= 'a' && c <= 'f') ? c - 'a' + 10
                                                   : -1;
            if (d < 0) return false;
            v = (v << 4) | static_cast<uint32_t>(d);
        }
        *cp = v;
        return true;
    };
    auto appendCp = [&](uint32_t cp) {
        if (cp == 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
            return false;
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(cp));
        }
        return true;
    };

    size_t from = 0;
    while (from <= n.size()) {
        size_t sep = n.find('_', from);
        if (sep == std::string::npos) sep = n.size();
        const std::string part = n.substr(from, sep - from);
        from = sep + 1;
        uint32_t cp = 0;
        if (part.size() >= 7 && part.compare(0, 3, "uni") == 0 &&
            (part.size() - 3) % 4 == 0) {

            for (size_t k = 3; k < part.size(); k += 4) {
                if (!hexRun(part, k, 4, &cp) || !appendCp(cp)) return {};
            }
        } else if (part.size() >= 5 && part.size() <= 7 && part[0] == 'u') {
            if (!hexRun(part, 1, part.size() - 1, &cp) || !appendCp(cp))
                return {};
        } else {
            return {};
        }
    }
    return out;
}

uint32_t hbGlyphIdForText(const uint8_t* fontData, size_t fontSize,
                          const std::u16string& want) {
    if (!fontData || !fontSize || want.empty()) return 0;
    HbFontEntry* e = hbFontFor(fontData, fontSize);
    if (!e || !e->font) return 0;
    auto hasInk = [&](hb_codepoint_t gid) {
        hb_glyph_extents_t ext = {};
        if (!hb_font_get_glyph_extents(e->font, gid, &ext)) return true;
        return ext.width != 0 || ext.height != 0;
    };
    if (want.size() == 1) {
        hb_codepoint_t gid = 0;
        if (hb_font_get_nominal_glyph(e->font, want[0], &gid) && gid &&
            hasInk(gid))
            return gid;
    }
    static std::map<const uint8_t*, std::map<std::u16string, uint32_t>> nameIdx;
    auto it = nameIdx.find(fontData);
    if (it == nameIdx.end()) {
        std::map<std::u16string, uint32_t> m;
        const unsigned n = hb_face_get_glyph_count(e->face);
        for (unsigned g = 1; g < n && g < 65536; g++) {
            const std::u16string t = hbGlyphNameText(fontData, fontSize, g);
            if (!t.empty()) m.emplace(t, g);
        }
        it = nameIdx.emplace(fontData, std::move(m)).first;
    }
    auto f = it->second.find(want);
    if (f != it->second.end() && hasInk(f->second)) return f->second;
    return 0;
}

float hbMeasureText(const uint8_t* fontData, size_t fontSize,
                    const std::u16string& text) {
    std::vector<ShapedGlyph> glyphs;
    if (!hbShapeText(fontData, fontSize, text, glyphs)) return -1.0f;
    float w = 0;
    for (const auto& g : glyphs) w += g.advance;
    return w;
}

namespace {
std::string hbNameOf(hb_face_t* face, hb_ot_name_id_t id) {
    char buf[128] = {0};
    unsigned n = sizeof(buf) - 1;
    hb_ot_name_get_utf8(face, id, HB_LANGUAGE_INVALID, &n, buf);
    std::string out(buf);
    for (auto& c : out) c = static_cast<char>(tolower(c));
    return out;
}
std::string squash(const std::string& in) {
    std::string out;
    for (char c : in)
        if (c != ' ' && c != '-' && c != '_') out += static_cast<char>(tolower(c));
    return out;
}
}

unsigned hbPickFace(const uint8_t* data, size_t size, const std::string& family,
                    bool bold, bool italic) {
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(data),
                                     static_cast<unsigned>(size),
                                     HB_MEMORY_MODE_READONLY, nullptr, nullptr);
    const unsigned count = hb_face_count(blob);
    if (count <= 1) { hb_blob_destroy(blob); return 0; }
    const std::string wantFam = squash(family);
    int bestScore = -1;
    unsigned best = 0;
    for (unsigned i = 0; i < count; i++) {
        hb_face_t* f = hb_face_create(blob, i);
        if (!f) continue;
        const std::string fam =
            squash(hbNameOf(f, HB_OT_NAME_ID_FONT_FAMILY));
        const std::string tfam =
            squash(hbNameOf(f, HB_OT_NAME_ID_TYPOGRAPHIC_FAMILY));
        const std::string sub = hbNameOf(f, HB_OT_NAME_ID_FONT_SUBFAMILY) + " " +
                                hbNameOf(f, HB_OT_NAME_ID_TYPOGRAPHIC_SUBFAMILY);
        int score = 0;
        if (!wantFam.empty() &&
            (fam == wantFam || tfam == wantFam)) score += 8;
        else if (!wantFam.empty() &&
                 (fam.find(wantFam) != std::string::npos ||
                  wantFam.find(fam) != std::string::npos)) score += 4;
        const bool faceBold = sub.find("bold") != std::string::npos ||
                              sub.find("black") != std::string::npos ||
                              sub.find("heavy") != std::string::npos;
        const bool faceItalic = sub.find("italic") != std::string::npos ||
                                sub.find("oblique") != std::string::npos;
        if (faceBold == bold) score += 2;
        if (faceItalic == italic) score += 2;
        const bool plain = !faceBold && !faceItalic &&
                           sub.find("light") == std::string::npos &&
                           sub.find("thin") == std::string::npos &&
                           sub.find("condensed") == std::string::npos;
        if (plain && !bold && !italic) score += 1;
        if (score > bestScore) { bestScore = score; best = i; }
        hb_face_destroy(f);
    }
    hb_blob_destroy(blob);
    return best;
}

std::vector<uint8_t> hbExtractFace(const uint8_t* data, size_t size,
                                   unsigned index) {
    std::vector<uint8_t> out;
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(data),
                                     static_cast<unsigned>(size),
                                     HB_MEMORY_MODE_READONLY, nullptr, nullptr);
    hb_face_t* src = hb_face_create(blob, index);
    hb_blob_destroy(blob);
    if (!src || hb_face_get_glyph_count(src) == 0) {
        hb_face_destroy(src);
        return out;
    }
    hb_face_t* builder = hb_face_builder_create();
    unsigned nt = hb_face_get_table_tags(src, 0, nullptr, nullptr);
    std::vector<hb_tag_t> tags(nt);
    hb_face_get_table_tags(src, 0, &nt, tags.data());
    for (hb_tag_t tag : tags) {
        hb_blob_t* tb = hb_face_reference_table(src, tag);
        if (tb && tb != hb_blob_get_empty())
            hb_face_builder_add_table(builder, tag, tb);
        if (tb) hb_blob_destroy(tb);
    }
    hb_blob_t* result = hb_face_reference_blob(builder);
    unsigned len = 0;
    const char* rd = hb_blob_get_data(result, &len);
    if (rd && len) out.assign(rd, rd + len);
    hb_blob_destroy(result);
    hb_face_destroy(builder);
    hb_face_destroy(src);
    return out;
}

bool hbFontHasGlyph(const uint8_t* data, size_t size, uint32_t cp) {
    HbFontEntry* e = hbFontFor(data, size);
    if (!e || !e->font) return false;
    hb_codepoint_t gid = 0;
    if (!hb_font_get_nominal_glyph(e->font, cp, &gid) || gid == 0)
        return false;
    if (cp == u' ' || cp == 0x00A0 || cp == u'\t' || cp == 0x3000)
        return true;
    hb_glyph_extents_t ext = {};
    if (!hb_font_get_glyph_extents(e->font, gid, &ext)) return true;
    return ext.width != 0 || ext.height != 0;
}

std::vector<uint8_t> withFontName(const std::vector<uint8_t>& fontBytes,
                                  const std::string& taggedFamily) {
    std::vector<uint8_t> out;
    if (fontBytes.empty() || taggedFamily.empty()) return out;
    hb_blob_t* blob = hb_blob_create(
        reinterpret_cast<const char*>(fontBytes.data()),
        static_cast<unsigned>(fontBytes.size()), HB_MEMORY_MODE_READONLY,
        nullptr, nullptr);
    hb_face_t* src = hb_face_create(blob, 0);
    hb_blob_destroy(blob);
    if (!src || hb_face_get_glyph_count(src) == 0) {
        hb_face_destroy(src);
        return out;
    }

    std::string fam = taggedFamily;
    if (fam.size() > 60) fam.resize(60);
    std::vector<uint8_t> name;
    auto u16 = [&](uint16_t v) {
        name.push_back(v >> 8);
        name.push_back(v & 0xFF);
    };
    const uint16_t famLen = static_cast<uint16_t>(fam.size() * 2);
    u16(0); u16(5); u16(6 + 5 * 12);
    const uint16_t ids[] = {1, 2, 3, 4, 6};
    for (uint16_t id : ids) {
        const bool style = id == 2;
        u16(3); u16(1); u16(0x0409);
        u16(id);
        u16(style ? 14 : famLen);
        u16(style ? famLen : 0);
    }
    for (char c : fam) u16(static_cast<uint16_t>(static_cast<unsigned char>(c)));
    for (char c : {'R', 'e', 'g', 'u', 'l', 'a', 'r'})
        u16(static_cast<uint16_t>(c));

    hb_face_t* builder = hb_face_builder_create();
    unsigned nt = hb_face_get_table_tags(src, 0, nullptr, nullptr);
    std::vector<hb_tag_t> tags(nt);
    hb_face_get_table_tags(src, 0, &nt, tags.data());
    for (hb_tag_t tag : tags) {
        if (tag == HB_TAG('n', 'a', 'm', 'e')) continue;
        hb_blob_t* tb = hb_face_reference_table(src, tag);
        if (tb && tb != hb_blob_get_empty())
            hb_face_builder_add_table(builder, tag, tb);
        if (tb) hb_blob_destroy(tb);
    }
    hb_blob_t* nb = hb_blob_create(reinterpret_cast<const char*>(name.data()),
                                   static_cast<unsigned>(name.size()),
                                   HB_MEMORY_MODE_DUPLICATE, nullptr, nullptr);
    hb_face_builder_add_table(builder, HB_TAG('n', 'a', 'm', 'e'), nb);
    hb_blob_destroy(nb);
    hb_blob_t* result = hb_face_reference_blob(builder);
    unsigned len = 0;
    const char* rd = hb_blob_get_data(result, &len);
    if (rd && len) out.assign(rd, rd + len);
    hb_blob_destroy(result);
    hb_face_destroy(builder);
    hb_face_destroy(src);
    return out;
}

std::vector<uint8_t> hbSubsetFont(const uint8_t* fontData, size_t fontSize,
                                  const std::vector<uint32_t>& unicodes) {
    std::vector<uint8_t> out;
    if (!fontData || !fontSize || unicodes.empty()) return out;
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(fontData),
                                     static_cast<unsigned>(fontSize),
                                     HB_MEMORY_MODE_READONLY, nullptr, nullptr);
    hb_face_t* face = hb_face_create(blob, 0);
    hb_blob_destroy(blob);
    if (!face || hb_face_get_glyph_count(face) == 0) {
        hb_face_destroy(face);
        return out;
    }
    hb_subset_input_t* input = hb_subset_input_create_or_fail();
    if (!input) {
        hb_face_destroy(face);
        return out;
    }
    hb_set_t* uset = hb_subset_input_unicode_set(input);
    for (uint32_t cp : unicodes) hb_set_add(uset, cp);
    hb_face_t* sub = hb_subset_or_fail(face, input);
    hb_subset_input_destroy(input);
    hb_face_destroy(face);
    if (!sub) return out;
    hb_blob_t* result = hb_face_reference_blob(sub);
    unsigned len = 0;
    const char* data = hb_blob_get_data(result, &len);
    if (data && len) out.assign(data, data + len);
    hb_blob_destroy(result);
    hb_face_destroy(sub);

    if (!out.empty()) {
        hb_blob_t* vb = hb_blob_create(reinterpret_cast<const char*>(out.data()),
                                       static_cast<unsigned>(out.size()),
                                       HB_MEMORY_MODE_READONLY, nullptr, nullptr);
        hb_face_t* vf = hb_face_create(vb, 0);
        hb_blob_destroy(vb);
        hb_font_t* vfont = vf ? hb_font_create(vf) : nullptr;
        bool ok = vfont != nullptr;
        if (ok) {
            for (uint32_t cp : unicodes) {
                if (cp == u' ' || cp == u'\n' || cp == u'\r') continue;
                hb_codepoint_t gid = 0;
                if (!hb_font_get_nominal_glyph(vfont, cp, &gid) || !gid) {
                    ok = false;
                    break;
                }
            }
        }
        if (vfont) hb_font_destroy(vfont);
        if (vf) hb_face_destroy(vf);
        if (!ok) out.clear();
    }
    return out;
}

std::string buildToUnicodeForFont(const uint8_t* data, size_t size) {
    hb_blob_t* blob = hb_blob_create(reinterpret_cast<const char*>(data),
                                     static_cast<unsigned>(size),
                                     HB_MEMORY_MODE_READONLY, nullptr, nullptr);
    hb_face_t* face = hb_face_create(blob, 0);
    hb_blob_destroy(blob);
    if (!face) return "";
    hb_font_t* font = hb_font_create(face);
    hb_set_t* us = hb_set_create();
    hb_face_collect_unicodes(face, us);
    std::vector<std::pair<uint32_t, uint32_t>> gidUni;
    std::set<uint32_t> seenGid;
    hb_codepoint_t cp = HB_SET_VALUE_INVALID;
    while (hb_set_next(us, &cp)) {
        hb_codepoint_t gid = 0;
        if (!hb_font_get_nominal_glyph(font, cp, &gid) || !gid) continue;
        if (gid > 0xFFFF) continue;
        if (!seenGid.insert(gid).second) continue;
        gidUni.push_back({gid, cp});
        if (gidUni.size() >= 20000) break;
    }
    hb_set_destroy(us);
    hb_font_destroy(font);
    hb_face_destroy(face);
    if (gidUni.empty()) return "";
    std::sort(gidUni.begin(), gidUni.end());
    std::string cmap =
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
    char hex[24];
    for (size_t b = 0; b < gidUni.size(); b += 100) {
        const size_t n = std::min<size_t>(100, gidUni.size() - b);
        cmap += std::to_string(n) + " beginbfchar\n";
        for (size_t k = b; k < b + n; k++) {
            const uint32_t u = gidUni[k].second;
            if (u <= 0xFFFF) {
                snprintf(hex, sizeof(hex), "<%04X> <%04X>\n",
                         gidUni[k].first & 0xFFFF, u);
            } else {
                const uint32_t v = u - 0x10000;
                snprintf(hex, sizeof(hex), "<%04X> <%04X%04X>\n",
                         gidUni[k].first & 0xFFFF,
                         0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF));
            }
            cmap += hex;
        }
        cmap += "endbfchar\n";
    }
    cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    return cmap;
}

namespace {
struct DrawCtx {
    std::vector<std::vector<OutlinePt>>* contours;
    float px = 0, py = 0;
};
void drawMoveTo(hb_draw_funcs_t*, void* data, hb_draw_state_t*, float x, float y,
                void*) {
    auto* c = static_cast<DrawCtx*>(data);
    c->contours->push_back({});
    c->contours->back().push_back({x, y, true});
    c->px = x; c->py = y;
}
void drawLineTo(hb_draw_funcs_t*, void* data, hb_draw_state_t*, float x, float y,
                void*) {
    auto* c = static_cast<DrawCtx*>(data);
    if (!c->contours->empty()) c->contours->back().push_back({x, y, true});
    c->px = x; c->py = y;
}
void drawQuadTo(hb_draw_funcs_t*, void* data, hb_draw_state_t*, float cx, float cy,
                float x, float y, void*) {
    auto* c = static_cast<DrawCtx*>(data);
    if (!c->contours->empty()) {
        c->contours->back().push_back({cx, cy, false});
        c->contours->back().push_back({x, y, true});
    }
    c->px = x; c->py = y;
}
void drawCubicTo(hb_draw_funcs_t*, void* data, hb_draw_state_t*, float x1, float y1,
                 float x2, float y2, float x3, float y3, void*) {
    auto* c = static_cast<DrawCtx*>(data);
    if (c->contours->empty()) return;
    auto& out = c->contours->back();

    const float x0 = c->px, y0 = c->py;
    const float ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
    const float bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
    const float cx2 = (x2 + x3) / 2, cy2 = (y2 + y3) / 2;
    const float dx = (ax + bx) / 2, dy = (ay + by) / 2;
    const float ex = (bx + cx2) / 2, ey = (by + cy2) / 2;
    const float fx = (dx + ex) / 2, fy = (dy + ey) / 2;
    auto quad = [&](float qx0, float qy0, float c1x, float c1y, float c2x,
                    float c2y, float qx3, float qy3) {
        out.push_back({(3 * (c1x + c2x) - qx0 - qx3) / 4,
                       (3 * (c1y + c2y) - qy0 - qy3) / 4, false});
        out.push_back({qx3, qy3, true});
    };
    quad(x0, y0, ax, ay, dx, dy, fx, fy);
    quad(fx, fy, ex, ey, cx2, cy2, x3, y3);
    c->px = x3; c->py = y3;
}
void drawClose(hb_draw_funcs_t*, void*, hb_draw_state_t*, void*) {}
}

bool hbGlyphContours(const uint8_t* fontData, size_t fontSize, uint32_t gid,
                     std::vector<std::vector<OutlinePt>>& contours) {
    contours.clear();
    HbFontEntry* e = hbFontFor(fontData, fontSize);
    if (!e || !e->font) return false;
    static hb_draw_funcs_t* dfuncs = nullptr;
    if (!dfuncs) {
        dfuncs = hb_draw_funcs_create();
        hb_draw_funcs_set_move_to_func(dfuncs, drawMoveTo, nullptr, nullptr);
        hb_draw_funcs_set_line_to_func(dfuncs, drawLineTo, nullptr, nullptr);
        hb_draw_funcs_set_quadratic_to_func(dfuncs, drawQuadTo, nullptr, nullptr);
        hb_draw_funcs_set_cubic_to_func(dfuncs, drawCubicTo, nullptr, nullptr);
        hb_draw_funcs_set_close_path_func(dfuncs, drawClose, nullptr, nullptr);
        hb_draw_funcs_make_immutable(dfuncs);
    }
    DrawCtx ctx;
    ctx.contours = &contours;
    hb_font_draw_glyph(e->font, gid, dfuncs, &ctx);

    if (e->upem != 1000) {
        const float k = 1000.0f / static_cast<float>(e->upem);
        for (auto& c : contours)
            for (auto& pt : c) { pt.x *= k; pt.y *= k; }
    }
    return true;
}

}

extern "C" {

char* ec_test_shape(const char* utf8, const unsigned char* font,
                    unsigned long font_size) {
    using namespace ec;
    if (!utf8 || !font || !font_size) return nullptr;
    std::u16string t = utf8ToUtf16(utf8);
    std::vector<ShapedGlyph> glyphs;
    if (!hbShapeText(font, font_size, t, glyphs)) return nullptr;
    std::string j = "{\"glyphs\":[";
    for (size_t i = 0; i < glyphs.size(); i++) {
        if (i) j += ",";
        j += "{\"gid\":" + std::to_string(glyphs[i].gid) +
             ",\"adv\":" + std::to_string(glyphs[i].advance) +
             ",\"dx\":" + std::to_string(glyphs[i].dx) +
             ",\"dy\":" + std::to_string(glyphs[i].dy) +
             ",\"cl\":" + std::to_string(glyphs[i].cluster) + "}";
    }
    j += "]}";
    char* out = static_cast<char*>(malloc(j.size() + 1));
    if (!out) return nullptr;
    memcpy(out, j.c_str(), j.size() + 1);
    return out;
}

unsigned char* ec_test_subset(const unsigned char* font, unsigned long size,
                              const char* utf8, unsigned long* out_size) {
    using namespace ec;
    if (out_size) *out_size = 0;
    if (!font || !size || !utf8 || !out_size) return nullptr;
    std::u16string t = utf8ToUtf16(utf8);
    std::vector<uint32_t> cps;
    for (char16_t c : t) cps.push_back(c);
    for (uint32_t c = 0x20; c <= 0x7E; c++) cps.push_back(c);
    std::vector<uint8_t> sub = hbSubsetFont(font, size, cps);
    if (sub.empty()) return nullptr;
    unsigned char* out = static_cast<unsigned char*>(malloc(sub.size()));
    memcpy(out, sub.data(), sub.size());
    *out_size = sub.size();
    return out;
}

}


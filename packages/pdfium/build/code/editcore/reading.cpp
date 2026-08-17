#include "ec_internal.h"

#include <algorithm>
#include <cmath>

namespace ec {
namespace {

bool isSpaceLike(char16_t c) {
    return c == u' ' || c == u'\t' || c == u'\n' || c == u'\r' || c == 0x00A0 ||
           c == 0x2007 || c == 0x202F || c == 0x3000;
}

struct Box {
    float x0, y0, x1, y1;
};

Box boxOf(const Paragraph& p) {
    return {p.x, p.top - p.height, p.x + p.width, p.top};
}

int columnOf(const PageState& st, const Box& b) {
    int col = 0;
    for (const auto& g : st.gutters) {
        if (g.x1 > b.x0 + 0.5f) continue;
        const float lo = std::min(g.yTop, g.yBot), hi = std::max(g.yTop, g.yBot);
        if (b.y1 < lo - 1.0f || b.y0 > hi + 1.0f) continue;
        col++;
    }
    return col;
}

float dominantSize(const Paragraph& p) {
    float best = 0;
    size_t bestLen = 0;
    for (const auto& r : p.runs) {
        if (r.text.size() >= bestLen) { bestLen = r.text.size(); best = r.style.size; }
    }
    return best > 0 ? best : 12.0f;
}

std::u16string paraText(const Paragraph& p) {
    std::u16string t;
    for (const auto& r : p.runs) t += r.text;
    return t;
}

bool allCaps(const std::u16string& t) {
    int upper = 0, lower = 0;
    for (char16_t c : t) {
        if (c >= u'A' && c <= u'Z') upper++;
        else if (c >= u'a' && c <= u'z') lower++;
    }
    return upper >= 3 && lower == 0;
}

}

const char* paragraphRole(const PageState& st, const Paragraph& p,
                          float pageWidth, float pageHeight) {
    if (!pageHeight) return "body";
    const Box b = boxOf(p);
    const std::u16string txt = paraText(p);
    size_t visible = 0;
    for (char16_t c : txt) if (!isSpaceLike(c)) visible++;
    if (!visible) return "body";

    std::vector<float> sizes;
    for (const auto& q : st.paras) {
        size_t vis = 0;
        for (const auto& r : q.runs)
            for (char16_t c : r.text) if (!isSpaceLike(c)) vis++;
        if (vis >= 20) sizes.push_back(dominantSize(q));
    }
    float body = 12.0f;
    if (!sizes.empty()) {
        std::sort(sizes.begin(), sizes.end());
        body = sizes[sizes.size() / 2];
    }
    const float size = dominantSize(p);
    const bool oneLine = p.lines.size() <= 1;

    const float topBand = pageHeight * 0.94f;
    const float botBand = pageHeight * 0.06f;
    if (oneLine && visible <= 120 && p.width < pageWidth * 0.9f) {
        if (b.y0 >= topBand) return "header";
        if (b.y1 <= botBand) return "footer";
    }

    if (size >= body * 1.6f && b.y0 > pageHeight * 0.6f && p.lines.size() <= 3)
        return "title";
    if (size >= body * 1.15f && p.lines.size() <= 3 && visible <= 200)
        return "heading";
    if (allCaps(txt) && p.lines.size() <= 3 && visible <= 90) return "heading";
    return "body";
}

std::vector<size_t> readingOrder(const PageState& st) {
    std::vector<size_t> idx(st.paras.size());
    for (size_t i = 0; i < idx.size(); i++) idx[i] = i;
    std::vector<int> col(st.paras.size());
    std::vector<Box> boxes(st.paras.size());
    for (size_t i = 0; i < st.paras.size(); i++) {
        boxes[i] = boxOf(st.paras[i]);
        col[i] = columnOf(st, boxes[i]);
    }
    std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) {
        if (col[a] != col[b]) return col[a] < col[b];

        const float dy = boxes[b].y1 - boxes[a].y1;
        const float band = 0.5f * std::max(4.0f, dominantSize(st.paras[a]));
        if (std::abs(dy) > band) return boxes[a].y1 > boxes[b].y1;
        return boxes[a].x0 < boxes[b].x0;
    });
    return idx;
}

namespace {

struct CharBox {
    size_t index;
    float x0, x1, y0, y1;
};

std::vector<CharBox> paragraphCharBoxes(const Paragraph& p) {
    std::vector<CharBox> out;
    std::u16string text;
    for (const auto& r : p.runs) text += r.text;
    if (p.lines.empty() || text.empty()) return out;
    for (size_t li = 0; li < p.lines.size(); li++) {
        const LineInfo& ln = p.lines[li];
        const size_t from = static_cast<size_t>(std::max<long>(0, ln.off));
        const size_t to = li + 1 < p.lines.size()
            ? static_cast<size_t>(std::max<long>(0, p.lines[li + 1].off))
            : text.size();
        if (from >= to || to > text.size()) continue;
        size_t n = 0;
        for (size_t i = from; i < to; i++)
            if (text[i] != u'\n' && text[i] != u'\r') n++;
        if (!n) continue;
        const float step = ln.w / static_cast<float>(n);
        float x = ln.hasPenX ? ln.penX : ln.x;
        float size = 12;
        for (const auto& r : p.runs) size = std::max(size, r.style.size);
        size_t k = 0;
        for (size_t i = from; i < to; i++) {
            if (text[i] == u'\n' || text[i] == u'\r') continue;
            CharBox cb;
            cb.index = i;
            cb.x0 = x + step * static_cast<float>(k);
            cb.x1 = cb.x0 + step;
            cb.y0 = ln.baseline - 0.25f * size;
            cb.y1 = ln.baseline + 0.85f * size;
            out.push_back(cb);
            k++;
        }
    }
    return out;
}

}

std::string selectText(const PageState& st, float ax, float ay, float bx,
                       float by, int mode) {
    const float rx0 = std::min(ax, bx), rx1 = std::max(ax, bx);
    const float ry0 = std::min(ay, by), ry1 = std::max(ay, by);
    const std::vector<size_t> order = readingOrder(st);
    std::string text, quads, blocks;

    bool started = false, finished = false;
    for (size_t oi = 0; oi < order.size(); oi++) {
        const Paragraph& p = st.paras[order[oi]];
        if (finished) break;
        const std::vector<CharBox> boxes = paragraphCharBoxes(p);
        if (boxes.empty()) continue;
        std::u16string ptext;
        for (const auto& r : p.runs) ptext += r.text;
        long first = -1, last = -1;
        for (size_t i = 0; i < boxes.size(); i++) {
            const CharBox& cb = boxes[i];
            bool take = false;
            if (mode == 1) {
                take = cb.x1 > rx0 && cb.x0 < rx1 && cb.y1 > ry0 && cb.y0 < ry1;
            } else {

                const bool afterStart = started ||
                    (cb.y0 <= (ay > by ? ay : by) + 0.01f &&
                     (cb.y1 >= (ay > by ? ay : by) - 0.01f ? cb.x1 >= (ay > by ? ax : bx) : true));
                const bool beforeEnd =
                    cb.y1 >= (ay > by ? by : ay) - 0.01f &&
                    (cb.y0 <= (ay > by ? by : ay) + 0.01f ? cb.x0 <= (ay > by ? bx : ax) : true);
                take = afterStart && beforeEnd;
                if (take) started = true;
                else if (started) { finished = true; break; }
            }
            if (!take) continue;
            if (first < 0) first = static_cast<long>(cb.index);
            last = static_cast<long>(cb.index);
            if (!quads.empty()) quads += ",";
            char buf[128];
            snprintf(buf, sizeof(buf), "{\"x\":%.2f,\"y\":%.2f,\"w\":%.2f,\"h\":%.2f}",
                     cb.x0, cb.y0, cb.x1 - cb.x0, cb.y1 - cb.y0);
            quads += buf;
        }
        if (first < 0) continue;
        const size_t f = static_cast<size_t>(first);
        const size_t l = std::min(ptext.size(), static_cast<size_t>(last) + 1);
        if (!text.empty()) text += "\n";
        text += utf16ToUtf8(ptext.substr(f, l - f));
        if (!blocks.empty()) blocks += ",";
        blocks += "{\"id\":" + std::to_string(p.id) +
                  ",\"from\":" + std::to_string(f) +
                  ",\"to\":" + std::to_string(l) + "}";
    }
    std::string j = "{\"text\":\"";
    jsonEscapeInto(j, text);
    j += "\",\"quads\":[" + quads + "],\"blocks\":[" + blocks + "]}";
    return j;
}

}


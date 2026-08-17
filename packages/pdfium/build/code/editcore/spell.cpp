#include "ec_internal.h"

#include <algorithm>
#include <cctype>

namespace ec {
namespace {

bool isWordChar(char16_t c) {
    return (c >= u'a' && c <= u'z') || (c >= u'A' && c <= u'Z') ||
           (c >= 0x00C0 && c <= 0x024F) ||
           c == u'\'' || c == 0x2019;
}

std::string lowerAscii(const std::u16string& w) {
    std::string out;
    out.reserve(w.size());
    for (char16_t c : w) {
        if (c > 0x7F) { out.push_back('?'); continue; }
        out.push_back(static_cast<char>(tolower(static_cast<unsigned char>(c))));
    }
    return out;
}

}

bool SpellDict::known(const std::string& w) const {
    return words.find(w) != words.end();
}

bool SpellDict::knownWithAffix(const std::string& w) const {
    if (known(w)) return true;
    const size_t n = w.size();
    auto tryStem = [&](const std::string& stem) { return stem.size() >= 2 && known(stem); };

    if (n > 2 && w.compare(n - 2, 2, "'s") == 0 && tryStem(w.substr(0, n - 2))) return true;
    if (n > 1 && w[n - 1] == 's') {
        if (tryStem(w.substr(0, n - 1))) return true;
        if (n > 2 && w.compare(n - 2, 2, "es") == 0 && tryStem(w.substr(0, n - 2))) return true;
        if (n > 3 && w.compare(n - 3, 3, "ies") == 0 &&
            tryStem(w.substr(0, n - 3) + "y")) return true;
    }
    for (const char* suf : {"ed", "ing", "er", "est", "ly", "ness", "ment", "s"}) {
        const size_t sl = strlen(suf);
        if (n <= sl + 1 || w.compare(n - sl, sl, suf) != 0) continue;
        const std::string base = w.substr(0, n - sl);
        if (tryStem(base)) return true;

        const bool dropsE = sl <= 3 && (suf[0] == 'e' || suf[0] == 'i');
        if (dropsE && tryStem(base + "e")) return true;
        if (base.size() > 2 && base[base.size() - 1] == base[base.size() - 2] &&
            tryStem(base.substr(0, base.size() - 1))) return true;
        if (base.size() > 1 && base.back() == 'i' &&
            tryStem(base.substr(0, base.size() - 1) + "y")) return true;
    }
    return false;
}

bool SpellDict::skippable(const std::u16string& w) const {
    if (w.size() < 3) return true;
    bool anyLower = false, anyUpper = false, anyDigit = false, nonLatin = false;
    for (char16_t c : w) {
        if (c >= u'a' && c <= u'z') anyLower = true;
        else if (c >= u'A' && c <= u'Z') anyUpper = true;
        else if (c >= u'0' && c <= u'9') anyDigit = true;
        else if (c > 0x024F) nonLatin = true;
    }
    if (anyDigit || nonLatin) return true;
    if (anyUpper && !anyLower) return true;
    if (!anyLower && !anyUpper) return true;
    return false;
}

void SpellDict::load(const char* data, size_t len) {
    words.clear();
    std::string cur;
    cur.reserve(32);
    for (size_t i = 0; i < len; i++) {
        const char c = data[i];
        if (c == '\n' || c == '\r') {
            if (cur.size() >= 2) words.insert(cur);
            cur.clear();
        } else if (c != ' ' && c != '\t') {
            cur.push_back(static_cast<char>(tolower(static_cast<unsigned char>(c))));
        }
    }
    if (cur.size() >= 2) words.insert(cur);
}

std::string spellCheckPage(const Session& s, const PageState& st) {
    std::string out;
    if (s.dict.words.empty()) return "{\"words\":[],\"ready\":false}";
    const std::vector<size_t> order = readingOrder(st);
    for (size_t k = 0; k < order.size(); k++) {
        const Paragraph& p = st.paras[order[k]];
        if (!p.editable) continue;
        std::u16string text;
        for (const auto& r : p.runs) text += r.text;
        size_t i = 0;
        while (i < text.size()) {
            if (!isWordChar(text[i])) { i++; continue; }
            size_t j = i;
            while (j < text.size() && isWordChar(text[j])) j++;

            const bool glued =
                (i > 0 && (text[i - 1] == u'.' || text[i - 1] == u'/' ||
                           text[i - 1] == u'@' || text[i - 1] == u'\\')) ||
                (j < text.size() && (text[j] == u'.' || text[j] == u'/' ||
                                     text[j] == u'@'));
            if (glued) { i = j; continue; }
            std::u16string w = text.substr(i, j - i);

            while (!w.empty() && (w.front() == u'\'' || w.front() == 0x2019)) w.erase(w.begin());
            while (!w.empty() && (w.back() == u'\'' || w.back() == 0x2019)) w.pop_back();
            if (!w.empty() && !s.dict.skippable(w)) {
                std::string probe = lowerAscii(w);
                for (char& c : probe) if (c == '\'') c = '\'';
                if (probe.find('?') == std::string::npos && !s.dict.knownWithAffix(probe)) {
                    if (!out.empty()) out += ",";
                    out += "{\"id\":" + std::to_string(p.id) +
                           ",\"from\":" + std::to_string(i) +
                           ",\"to\":" + std::to_string(j) + ",\"word\":\"";
                    jsonEscapeInto(out, utf16ToUtf8(w));
                    out += "\"}";
                }
            }
            i = j;
        }
    }
    return "{\"words\":[" + out + "],\"ready\":true}";
}

}


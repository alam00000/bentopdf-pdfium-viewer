#ifndef EC_PDFIUM_INTERNAL_H
#define EC_PDFIUM_INTERNAL_H

#include <cstddef>
#include <cstdint>
#include <vector>

class CPDF_TextObject {
public:

    struct Item {
        uint32_t char_code = 0;
        float x = 0;
        float y = 0;
    };
    size_t CountItems() const;
    uint32_t GetCharCode(size_t index) const;
    Item GetItemInfo(size_t index) const;
};

namespace ec {

constexpr uint32_t kInvalidCharCode = 0xFFFFFFFFu;

struct OrigGlyph {
    uint32_t code;
    float x;
    float y;
};

inline std::vector<OrigGlyph> readOrigGlyphs(FPDF_PAGEOBJECT textObject) {
    std::vector<OrigGlyph> out;
#ifdef __EMSCRIPTEN__
    if (!textObject) return out;
    const auto* t = reinterpret_cast<const CPDF_TextObject*>(textObject);
    const size_t n = t->CountItems();
    if (n == 0 || n > 200000) return out;
    out.reserve(n);
    for (size_t i = 0; i < n; i++) {
        const CPDF_TextObject::Item it = t->GetItemInfo(i);
        if (it.char_code != kInvalidCharCode)
            out.push_back({it.char_code, it.x, it.y});
    }
#else
    (void)textObject;
#endif
    return out;
}

inline std::vector<uint32_t> readOrigCharcodes(FPDF_PAGEOBJECT textObject) {
    std::vector<uint32_t> out;
    for (const auto& g : readOrigGlyphs(textObject)) out.push_back(g.code);
    return out;
}

}

#endif


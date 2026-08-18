#include "ec_internal.h"
#include "fpdf_transformpage.h"
#include "pdfium_internal.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/heap.h>
#include <memory>
#include <new>

namespace fxcrt {
template <typename T>
class StringPoolTemplate;

class [[clang::trivial_abi]] ByteString;
using ByteStringPool = StringPoolTemplate<ByteString>;

class [[clang::trivial_abi]] ByteString {
 public:
    ByteString() = default;
    explicit ByteString(const char* s);
    ~ByteString() {}
    void* d_ = nullptr;
};

template <typename T>
class [[clang::trivial_abi]] RetainPtr {
 public:
    RetainPtr() = default;
    ~RetainPtr() {}
    T* p_ = nullptr;
};

template <typename T, typename D = std::default_delete<T>>
class WeakPtr {
 public:
    WeakPtr() = default;
    ~WeakPtr() {}
    void* p_ = nullptr;
};

template <typename C>
class StringViewTemplate {
 public:
    StringViewTemplate(const C* p, size_t n) : p_(p), n_(n) {}
    const C* p_;
    size_t n_;
};
}

class CPDF_Object;
class CPDF_Font;
class CPDF_Document;
class CPDF_Stream;

class CPDF_Dictionary {
 public:
    fxcrt::RetainPtr<CPDF_Object> Clone() const;
    void SetFor(const fxcrt::ByteString& key, fxcrt::RetainPtr<CPDF_Object> v);
    fxcrt::ByteString GetByteStringFor(
        fxcrt::StringViewTemplate<char> key) const;
    fxcrt::RetainPtr<const CPDF_Stream> GetStreamFor(
        fxcrt::StringViewTemplate<char> key) const;
};

struct EcAbiSpan {
    const uint8_t* p;
    size_t n;
};

class CPDF_StreamAcc {
 public:
    explicit CPDF_StreamAcc(fxcrt::RetainPtr<const CPDF_Stream> stream);
    ~CPDF_StreamAcc();
    void LoadAllDataFiltered();
    EcAbiSpan GetSpan() const;
    uint32_t GetSize() const;
};

class CPDF_Name {
 public:
    CPDF_Name(fxcrt::WeakPtr<fxcrt::ByteStringPool> pool,
              const fxcrt::ByteString& str);
};

class CPDF_IndirectObjectHolder {
 public:
    uint32_t AddIndirectObject(fxcrt::RetainPtr<CPDF_Object> obj);
    CPDF_Object* GetOrParseIndirectObject(uint32_t objnum);
};

class CPDF_DocPageData {
 public:
    static CPDF_DocPageData* FromDocument(const CPDF_Document* doc);
    fxcrt::RetainPtr<CPDF_Font> GetFont(
        fxcrt::RetainPtr<CPDF_Dictionary> dict);
};

class CPDF_Document {
 public:
    fxcrt::RetainPtr<CPDF_Dictionary> GetPageDictionary(int index);
};
#endif

namespace ec {

namespace {

RunStyle styleForObject(FPDF_PAGEOBJECT obj) {
    RunStyle st;
    float size = 12.0f;
    FPDFTextObj_GetFontSize(obj, &size);
    st.size = size;
    FPDF_FONT font = FPDFTextObj_GetFont(obj);
    if (font) {
        char buf[256] = {0};
        size_t n = FPDFFont_GetFamilyName(font, buf, sizeof(buf));
        if (n <= 1) { buf[0] = 0; FPDFFont_GetBaseFontName(font, buf, sizeof(buf)); }
        std::string name(buf);

        if (name.size() > 7 && name[6] == '+') name = name.substr(7);

        char psBuf[256] = {0};
        FPDFFont_GetBaseFontName(font, psBuf, sizeof(psBuf));
        std::string lower = name + " " + psBuf;
        for (auto& c : lower) c = static_cast<char>(tolower(c));
        int weight = FPDFFont_GetWeight(font);
        int angle = 0;
        st.bold = weight >= 600 || lower.find("bold") != std::string::npos ||
                  lower.find("semibold") != std::string::npos;
        st.italic = (FPDFFont_GetItalicAngle(font, &angle) && angle != 0) ||
                    lower.find("italic") != std::string::npos ||
                    lower.find("oblique") != std::string::npos;

        auto dash = name.find('-');
        st.family = dash != std::string::npos ? name.substr(0, dash) : name;
    }
    unsigned int r = 0, g = 0, b = 0, a = 255;
    if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a)) {
        st.rgba = (r << 24) | (g << 16) | (b << 8) | a;
    }
    return st;
}

std::u16string objectText(FPDF_PAGEOBJECT obj, FPDF_TEXTPAGE tp) {
    std::u16string text;
    unsigned long len = FPDFTextObj_GetText(obj, tp, nullptr, 0);
    if (len >= 2) {
        std::vector<unsigned short> buf(len / 2 + 1, 0);
        unsigned long got = FPDFTextObj_GetText(obj, tp, buf.data(), len);
        if (got >= 2) text.assign(reinterpret_cast<char16_t*>(buf.data()), got / 2 - 1);
    }
    return text;
}

FPDF_PAGEOBJECT reencodeTextObject(Session& s, FPDF_PAGE page, FPDF_TEXTPAGE tp,
                                   FPDF_PAGEOBJECT obj, int index,
                                   bool rescueInvisible) {
    std::u16string text = objectText(obj, tp);
    auto skip = [&](const char* why) -> FPDF_PAGEOBJECT {
        if (getenv("EC_REENC_DEBUG")) {
            std::string t8;
            for (char16_t c : text)
                t8 += c < 128 ? static_cast<char>(c) : '?';
            fprintf(stderr, "[reenc] skip (%s): \"%.48s\"\n", why, t8.c_str());
        }
        return nullptr;
    };
    const std::vector<OrigGlyph> orig = readOrigGlyphs(obj);
    if (text.empty()) {

        float l = 0, b = 0, r = 0, t = 0;
        if (rescueInvisible && !orig.empty() &&
            FPDFPageObj_GetBounds(obj, &l, &b, &r, &t) &&
            (r - l < 0.01f || t - b < 0.01f)) {
            text.assign(orig.size(), u' ');
        }
        if (text.empty()) return skip("empty");
    }

    for (char16_t c : text) {
        if (isUndecodableChar(c)) return skip("undecodable");
    }

    while (!orig.empty() && text.size() > orig.size() &&
           (text.back() == u' ' || text.back() == u'\t' ||
            text.back() == u'\r' || text.back() == u'\n')) {
        text.pop_back();
    }

    RunStyle style = styleForObject(obj);
    std::vector<uint32_t> cps;
    std::set<uint32_t> seen;
    for (size_t i = 0; i < text.size(); i++) {
        uint32_t cp = text[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < text.size()) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (text[i + 1] - 0xDC00);
            i++;
        }
        if (cp == u'\n' || cp == u'\r') continue;
        if (seen.insert(cp).second) cps.push_back(cp);
    }

    if (getenv("EC_REENC_DEBUG")) {
        std::string t8;
        for (char16_t c : text) t8 += c < 128 ? static_cast<char>(c) : '?';
        fprintf(stderr, "[reenc] style fam=\"%s\" bold=%d italic=%d: \"%.24s\"\n",
                style.family.c_str(), style.bold ? 1 : 0, style.italic ? 1 : 0,
                t8.c_str());
    }
    FPDF_FONT font = resolveFont(s, style, nullptr, cps,
                                  false,
                                  nullptr,
                                  FPDFTextObj_GetFont(obj));
    if (!font) return skip("no substitute font");

    float size = style.size > 0.5f ? style.size : 12.0f;
    FPDF_PAGEOBJECT rebuilt = FPDFPageObj_CreateTextObj(s.doc, font, size);
    if (!rebuilt) return nullptr;

    std::vector<unsigned short> wide(text.begin(), text.end());
    wide.push_back(0);
    if (!FPDFText_SetText(rebuilt, wide.data())) {
        FPDFPageObj_Destroy(rebuilt);
        return skip("SetText failed");
    }
    FS_MATRIX m;
    if (FPDFPageObj_GetMatrix(obj, &m)) FPDFPageObj_SetMatrix(rebuilt, &m);

    {
        const size_t units = text.size();
        bool clean = !orig.empty() && orig.size() == units;
        for (size_t i = 0; clean && i < orig.size(); i++)
            if (orig[i].y != 0) clean = false;

        for (size_t i = 0; clean && i + 1 < orig.size(); i++)
            if (orig[i + 1].x < orig[i].x) clean = false;
        if (clean) {
            const float base = orig.front().x;

            std::vector<float> pos;
            pos.reserve(orig.size() > 1 ? orig.size() - 1 : 0);
            for (size_t i = 1; i < orig.size(); i++)
                pos.push_back(orig[i].x - base);
            if (!pos.empty())
                FPDFText_SetPositions(rebuilt, pos.data(), pos.size());
            if (base != 0) {
                FS_MATRIX m2 = m;
                m2.e += base * m.a;
                m2.f += base * m.b;
                FPDFPageObj_SetMatrix(rebuilt, &m2);
            }
        }
    }
    FPDFPageObj_SetFillColor(rebuilt, (style.rgba >> 24) & 0xFF, (style.rgba >> 16) & 0xFF,
                             (style.rgba >> 8) & 0xFF, style.rgba & 0xFF);
    FPDFTextObj_SetTextRenderMode(rebuilt, FPDFTextObj_GetTextRenderMode(obj));
    unsigned int sr = 0, sg = 0, sb = 0, sa = 255;
    if (FPDFPageObj_GetStrokeColor(obj, &sr, &sg, &sb, &sa)) {
        FPDFPageObj_SetStrokeColor(rebuilt, sr, sg, sb, sa);
    }
    float sw = 0;
    if (FPDFPageObj_GetStrokeWidth(obj, &sw) && sw > 0) {
        FPDFPageObj_SetStrokeWidth(rebuilt, sw);
    }

    FPDFPage_RemoveObject(page, obj);
    if (index >= 0 && index <= FPDFPage_CountObjects(page)) {
        FPDFPage_InsertObjectAtIndex(page, rebuilt, static_cast<size_t>(index));
    } else {
        FPDFPage_InsertObject(page, rebuilt);
    }
    FPDFPageObj_Destroy(obj);
    return rebuilt;
}

float objectWidth(FPDF_PAGEOBJECT obj) {
    float l = 0, b = 0, r = 0, t = 0;
    if (!FPDFPageObj_GetBounds(obj, &l, &b, &r, &t)) return -1;
    return r - l;
}

bool objectFontIsHonest(Session& s, FPDF_TEXTPAGE tp, FPDF_PAGEOBJECT obj) {
    std::u16string text = objectText(obj, tp);
    if (text.size() < 3) return true;
    FPDF_FONT font = FPDFTextObj_GetFont(obj);
    if (!font) return true;
    float origWidth = objectWidth(obj);
    if (origWidth <= 0) return true;
    float size = 12.0f;
    FPDFTextObj_GetFontSize(obj, &size);

    FPDF_PAGEOBJECT probe = FPDFPageObj_CreateTextObj(s.doc, font, size);
    if (!probe) return true;
    std::vector<unsigned short> wide(text.begin(), text.end());
    wide.push_back(0);
    if (!FPDFText_SetText(probe, wide.data())) { FPDFPageObj_Destroy(probe); return true; }
    FS_MATRIX m;
    if (FPDFPageObj_GetMatrix(obj, &m)) FPDFPageObj_SetMatrix(probe, &m);
    float probeWidth = objectWidth(probe);
    FPDFPageObj_Destroy(probe);
    if (probeWidth <= 0) return true;

    return std::abs(probeWidth - origWidth) <= origWidth * 0.12f;
}

}

bool pageNeedsReencode(Session& s, FPDF_PAGE page) {
    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (!tp) return false;
    int probed = 0;
    bool dishonest = false;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n && probed < 6 && !dishonest; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_TEXT) continue;
        if (objectText(o, tp).size() < 2) continue;
        probed++;
        if (!objectFontIsHonest(s, tp, o)) dishonest = true;
    }
    FPDFText_ClosePage(tp);
    return dishonest;
}

int reencodePageFonts(Session& s, FPDF_PAGE page,
                      std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT>* remap) {
    FPDF_TEXTPAGE tp = FPDFText_LoadPage(page);
    if (!tp) return 0;

    struct Item { FPDF_PAGEOBJECT obj; int index; };
    std::vector<Item> items;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (o && FPDFPageObj_GetType(o) == FPDF_PAGEOBJ_TEXT) items.push_back({o, i});
    }
    int rebuilt = 0;

    const bool forceAll = s.saveCorrupting.count(page) > 0;
    for (auto it = items.rbegin(); it != items.rend(); ++it) {

        if (!forceAll && objectFontIsHonest(s, tp, it->obj)) continue;
        FPDF_PAGEOBJECT fresh =
            reencodeTextObject(s, page, tp, it->obj, it->index, forceAll);
        if (fresh) {
            rebuilt++;
            if (remap) (*remap)[it->obj] = fresh;
        }
    }
    FPDFText_ClosePage(tp);
    if (rebuilt > 0) {

        historyDropPage(s, page);
    }
    return rebuilt;
}

#ifdef __EMSCRIPTEN__
namespace {

int32_t abiRefCount(const void* obj) {
    return *reinterpret_cast<const int32_t*>(
        static_cast<const char*>(obj) + 4);
}
void abiRefSet(void* obj, int32_t v) {
    *reinterpret_cast<int32_t*>(static_cast<char*>(obj) + 4) = v;
}

std::string abiByteStringChars(const fxcrt::ByteString& bs) {
    const char* sd = static_cast<const char*>(bs.d_);
    if (!sd) return std::string();
    const uint32_t len = *reinterpret_cast<const uint32_t*>(sd + 4);
    if (len == 0 || len > 300) return std::string();
    return std::string(sd + 12, len);
}

CPDF_IndirectObjectHolder* abiValidatedHolder(FPDF_DOCUMENT doc) {
    const bool dbg = getenv("EC_DEALIAS_DEBUG") != nullptr;
    auto* d = reinterpret_cast<CPDF_Document*>(doc);
    fxcrt::RetainPtr<CPDF_Dictionary> pd = d->GetPageDictionary(0);
    if (!pd.p_) {
        if (dbg) printf("[dealias] GetPageDictionary(0) null\n");
        return nullptr;
    }
    const uint32_t objnum =
        *reinterpret_cast<const uint32_t*>(
            reinterpret_cast<const char*>(pd.p_) + 8);
    if (dbg)
        printf("[dealias] page dict %p objnum guess %u\n",
                (void*)pd.p_, objnum);
    if (objnum == 0 || objnum > (50u << 20)) return nullptr;

    auto* holder = reinterpret_cast<CPDF_IndirectObjectHolder*>(doc);
    if (holder->GetOrParseIndirectObject(objnum) !=
        reinterpret_cast<CPDF_Object*>(pd.p_)) {
        if (dbg) printf("[dealias] holder round-trip failed\n");
        return nullptr;
    }
    if (dbg) printf("[dealias] holder confirmed\n");
    return holder;
}

uint32_t abiObjNum(const void* obj) {
    return *reinterpret_cast<const uint32_t*>(
        static_cast<const char*>(obj) + 8);
}

CPDF_Dictionary* abiFontDict(FPDF_DOCUMENT doc,
                             CPDF_IndirectObjectHolder* holder, FPDF_FONT font,
                             const std::string& expectBaseFont) {
    const bool dbg = getenv("EC_DEALIAS_DEBUG") != nullptr;
    const uint32_t docBits =
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(doc));
    const uint32_t* words = reinterpret_cast<const uint32_t*>(font);
    int hit = -1;
    for (int k = 0; k < 31; k++) {
        if (words[k] == docBits) {
            if (hit >= 0) {
                if (dbg) printf("[dealias] doc ptr ambiguous\n");
                return nullptr;
            }
            hit = k;
        }
    }
    if (hit < 0) {
        if (dbg) printf("[dealias] doc ptr not found in font\n");
        return nullptr;
    }

    const size_t heap = emscripten_get_heap_size();

    for (int k = 0; k < 32; k++) {
        if (k == hit) continue;
        const uint32_t bits = words[k];
        if (!bits || (bits & 3) || bits + 16 > heap) continue;
        auto* cand = reinterpret_cast<CPDF_Dictionary*>(
            static_cast<uintptr_t>(bits));
        const uint32_t objnum = abiObjNum(cand);
        if (objnum == 0 || objnum > (50u << 20)) continue;
        if (holder->GetOrParseIndirectObject(objnum) !=
            reinterpret_cast<CPDF_Object*>(cand))
            continue;

        const std::string got = abiByteStringChars(cand->GetByteStringFor(
            fxcrt::StringViewTemplate<char>("BaseFont", 8)));
        const bool tagged = got.size() == expectBaseFont.size() + 7 &&
                            got[6] == '+' &&
                            got.compare(7, std::string::npos,
                                        expectBaseFont) == 0;
        if (got != expectBaseFont && !tagged) {
            if (dbg)
                printf("[dealias] slot %d: obj %u BaseFont \"%s\" != \"%s\" "
                       "— not it\n",
                       k, objnum, got.c_str(), expectBaseFont.c_str());
            continue;
        }
        if (dbg)
            printf("[dealias] dict confirmed: obj %u at slot %d\n", objnum, k);
        return cand;
    }
    if (dbg) printf("[dealias] no dict candidate validated\n");
    return nullptr;
}

std::string fontBaseName(FPDF_FONT font) {
    char buf[256] = {0};
    const size_t n = FPDFFont_GetBaseFontName(font, buf, sizeof(buf));
    if (n == 0 || n > sizeof(buf)) return std::string();
    return std::string(buf, strnlen(buf, n));
}

FPDF_FONT cloneFontWithFreshName(Session& s, FPDF_FONT victim,
                                 const std::string& baseName,
                                 const std::set<std::string>& namesInUse,
                                 std::string* newNameOut) {
    const bool dbg = getenv("EC_DEALIAS_DEBUG") != nullptr;
    auto trace = [&](const char* msg) {
        if (dbg) { printf("[dealias] %s\n", msg); fflush(stdout); }
    };
    CPDF_IndirectObjectHolder* holder = abiValidatedHolder(s.doc);
    if (!holder) return nullptr;
    trace("holder ok, locating dict");
    CPDF_Dictionary* dict = abiFontDict(s.doc, holder, victim, baseName);
    if (!dict) return nullptr;
    trace("dict ok, cloning");

    fxcrt::RetainPtr<CPDF_Object> clone = dict->Clone();
    if (!clone.p_ || abiRefCount(clone.p_) != 1) {
        trace("clone refcount unexpected — abandon");
        return nullptr;
    }
    trace("clone ok, renaming");

    std::string stripped = baseName;
    if (stripped.size() > 7 && stripped[6] == '+') stripped = stripped.substr(7);
    std::string newName;
    std::string loadedName;
    do {
        std::string serial = "AAAA";
        for (uint32_t v = static_cast<uint32_t>(s.subsetSeq++), k = 0; k < 4;
             k++, v /= 26)
            serial[3 - k] = static_cast<char>('A' + (v % 26));
        loadedName = stripped + "-EC" + serial;
        newName = "ECAAAA+" + loadedName;
    } while (namesInUse.count(loadedName) || namesInUse.count(newName));

    trace("tag chosen");
    fxcrt::ByteString bsKey("BaseFont");
    trace("bsKey built");
    fxcrt::ByteString bsName(newName.c_str());
    trace("bsName built");
    void* mem = malloc(64);
    if (!mem) return nullptr;
    fxcrt::WeakPtr<fxcrt::ByteStringPool> nullPool;
    auto* nameObj = new (mem) CPDF_Name(nullPool, bsName);
    trace("CPDF_Name constructed");
    if (abiRefCount(nameObj) != 0) return nullptr;
    abiRefSet(nameObj, 1);
    fxcrt::RetainPtr<CPDF_Object> nameRef;
    nameRef.p_ = reinterpret_cast<CPDF_Object*>(nameObj);
    reinterpret_cast<CPDF_Dictionary*>(clone.p_)->SetFor(bsKey, nameRef);
    trace("SetFor done");

    const uint32_t objnum = holder->AddIndirectObject(clone);
    if (objnum == 0 || objnum > (50u << 20)) return nullptr;
    if (abiRefCount(clone.p_) < 1 || abiRefCount(clone.p_) > 4) return nullptr;
    abiRefSet(clone.p_, abiRefCount(clone.p_) + 1);
    fxcrt::RetainPtr<CPDF_Dictionary> cloneDict;
    cloneDict.p_ = reinterpret_cast<CPDF_Dictionary*>(clone.p_);
    fxcrt::RetainPtr<CPDF_Font> nf =
        CPDF_DocPageData::FromDocument(
            reinterpret_cast<const CPDF_Document*>(s.doc))
            ->GetFont(cloneDict);
    if (!nf.p_) return nullptr;
    FPDF_FONT out = reinterpret_cast<FPDF_FONT>(nf.p_);

    const std::string loaded = fontBaseName(out);
    if (dbg) {
        printf("[dealias] clone loaded as \"%s\" (dict \"%s\")\n",
               loaded.c_str(), newName.c_str());
        fflush(stdout);
    }
    if (loaded != loadedName && loaded != newName) return nullptr;
    if (newNameOut) *newNameOut = loadedName;
    return out;
}

void copyObjectMarks(FPDF_DOCUMENT doc, FPDF_PAGEOBJECT src,
                     FPDF_PAGEOBJECT dst) {
    const int nm = FPDFPageObj_CountMarks(src);
    for (int mi = 0; mi < nm; mi++) {
        FPDF_PAGEOBJECTMARK mk = FPDFPageObj_GetMark(src, mi);
        if (!mk) continue;
        unsigned long need = 0;
        char16_t nbuf[64] = {0};
        if (!FPDFPageObjMark_GetName(mk, reinterpret_cast<FPDF_WCHAR*>(nbuf),
                                     sizeof(nbuf), &need) ||
            need < 2)
            continue;
        const std::string name = utf16ToUtf8(std::u16string(nbuf));
        if (name.empty()) continue;
        FPDF_PAGEOBJECTMARK out = FPDFPageObj_AddMark(dst, name.c_str());
        if (!out) continue;
        const int np = FPDFPageObjMark_CountParams(mk);
        for (int pi = 0; pi < np; pi++) {
            char16_t kbuf[64] = {0};
            if (!FPDFPageObjMark_GetParamKey(
                    mk, pi, reinterpret_cast<FPDF_WCHAR*>(kbuf), sizeof(kbuf),
                    &need))
                continue;
            const std::string key = utf16ToUtf8(std::u16string(kbuf));
            const int vt = FPDFPageObjMark_GetParamValueType(mk, key.c_str());
            if (vt == FPDF_OBJECT_NUMBER) {
                int v = 0;
                if (FPDFPageObjMark_GetParamIntValue(mk, key.c_str(), &v))
                    FPDFPageObjMark_SetIntParam(doc, dst, out, key.c_str(), v);
            } else if (vt == FPDF_OBJECT_STRING || vt == FPDF_OBJECT_NAME) {
                char16_t vbuf[256] = {0};
                if (FPDFPageObjMark_GetParamStringValue(
                        mk, key.c_str(), reinterpret_cast<FPDF_WCHAR*>(vbuf),
                        sizeof(vbuf), &need)) {
                    FPDFPageObjMark_SetStringParam(
                        doc, dst, out, key.c_str(),
                        utf16ToUtf8(std::u16string(vbuf)).c_str());
                }
            }
        }
    }
}

FPDF_PAGEOBJECT buildFaithfulTwin(Session& s, FPDF_PAGEOBJECT obj,
                                  FPDF_FONT nf) {
    const std::vector<OrigGlyph> orig = readOrigGlyphs(obj);
    if (orig.empty()) return nullptr;
    for (const OrigGlyph& g : orig)
        if (g.y != 0) return nullptr;

    FPDF_CLIPPATH clip = FPDFPageObj_GetClipPath(obj);
    if (clip && FPDFClipPath_CountPaths(clip) > 0) return nullptr;
    float size = 0;
    if (!FPDFTextObj_GetFontSize(obj, &size) || size <= 0) return nullptr;

    FPDF_PAGEOBJECT tw = FPDFPageObj_CreateTextObj(s.doc, nf, size);
    if (!tw) return nullptr;
    auto fail = [&]() {
        FPDFPageObj_Destroy(tw);
        return static_cast<FPDF_PAGEOBJECT>(nullptr);
    };
    std::vector<uint32_t> codes;
    codes.reserve(orig.size());
    for (const OrigGlyph& g : orig) codes.push_back(g.code);
    if (!FPDFText_SetCharcodes(tw, codes.data(), codes.size())) return fail();

    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    FPDFPageObj_GetMatrix(obj, &m);
    FPDFPageObj_SetMatrix(tw, &m);

    const float base = orig.front().x;
    if (orig.size() > 1) {
        std::vector<float> pos;
        pos.reserve(orig.size() - 1);
        for (size_t i = 1; i < orig.size(); i++)
            pos.push_back(orig[i].x - base);
        FPDFText_SetPositions(tw, pos.data(), pos.size());
    }
    if (base != 0) {
        FS_MATRIX m2 = m;
        m2.e += base * m.a;
        m2.f += base * m.b;
        FPDFPageObj_SetMatrix(tw, &m2);
    }

    unsigned int r = 0, g = 0, b = 0, a = 255;
    if (FPDFPageObj_GetFillColor(obj, &r, &g, &b, &a))
        FPDFPageObj_SetFillColor(tw, r, g, b, a);
    FPDFTextObj_SetTextRenderMode(tw, FPDFTextObj_GetTextRenderMode(obj));
    unsigned int sr = 0, sg = 0, sb = 0, sa = 255;
    if (FPDFPageObj_GetStrokeColor(obj, &sr, &sg, &sb, &sa))
        FPDFPageObj_SetStrokeColor(tw, sr, sg, sb, sa);
    float sw = 0;
    if (FPDFPageObj_GetStrokeWidth(obj, &sw) && sw > 0)
        FPDFPageObj_SetStrokeWidth(tw, sw);
    copyObjectMarks(s.doc, obj, tw);

    float l0 = 0, b0 = 0, r0 = 0, t0 = 0, l1 = 0, b1 = 0, r1 = 0, t1 = 0;
    if (!FPDFPageObj_GetBounds(obj, &l0, &b0, &r0, &t0)) return fail();
    if (!FPDFPageObj_GetBounds(tw, &l1, &b1, &r1, &t1)) return fail();
    const float tol = 0.35f;
    if (std::abs(l0 - l1) > tol || std::abs(b0 - b1) > tol ||
        std::abs(r0 - r1) > tol || std::abs(t0 - t1) > tol)
        return fail();
    return tw;
}

}
#endif

int dealiasPageFonts(Session& s, FPDF_PAGE page, Paragraph* extra) {
#ifndef __EMSCRIPTEN__
    (void)s;
    (void)page;
    (void)extra;
    return 0;
#else
    if (!s.doc || !page) return 0;
    if (getenv("EC_NO_DEALIAS")) return 0;
    const bool dbg = getenv("EC_DEALIAS_DEBUG") != nullptr;
    auto trace = [&](const char* msg) {
        if (dbg) { printf("[dealias] %s\n", msg); fflush(stdout); }
    };
    trace("scan");

    struct Use {
        FPDF_PAGEOBJECT obj;
        int index;
    };
    std::map<std::string, std::map<FPDF_FONT, std::vector<Use>>> groups;
    std::set<std::string> namesInUse;
    const int n = FPDFPage_CountObjects(page);
    for (int i = 0; i < n; i++) {
        FPDF_PAGEOBJECT o = FPDFPage_GetObject(page, i);
        if (!o || FPDFPageObj_GetType(o) != FPDF_PAGEOBJ_TEXT) continue;
        FPDF_FONT f = FPDFTextObj_GetFont(o);
        if (!f) continue;
        const std::string name = fontBaseName(f);
        if (name.size() < 2) continue;
        groups[name][f].push_back({o, i});
        namesInUse.insert(name);
    }

    int swapped = 0;
    auto pit = s.pages.find(page);
    for (auto& [name, byFont] : groups) {
        if (byFont.size() < 2) continue;

        FPDF_FONT keep = nullptr;
        size_t keepUses = 0;
        for (const auto& [f, uses] : byFont)
            if (uses.size() > keepUses) { keep = f; keepUses = uses.size(); }
        for (auto& [victim, uses] : byFont) {
            if (victim == keep) continue;
            if (dbg) {
                printf("[dealias] collision \"%s\": %zu instances, victim %p "
                       "(%zu objs)\n",
                       name.c_str(), byFont.size(), (void*)victim,
                       uses.size());
                fflush(stdout);
            }
            std::string newName;
            FPDF_FONT nf =
                cloneFontWithFreshName(s, victim, name, namesInUse, &newName);
            if (!nf) continue;
            trace("clone font ready");
            namesInUse.insert(newName);

            std::vector<FPDF_PAGEOBJECT> twins(uses.size(), nullptr);
            bool ok = true;
            for (size_t k = 0; k < uses.size() && ok; k++) {
                twins[k] = buildFaithfulTwin(s, uses[k].obj, nf);
                ok = twins[k] != nullptr;
            }
            if (!ok) {
                for (FPDF_PAGEOBJECT t : twins)
                    if (t) FPDFPageObj_Destroy(t);
                continue;
            }
            std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT> remap;
            for (size_t k = 0; k < uses.size(); k++) {

                historyRemoveObject(s, page, nullptr, uses[k].obj);
                historyInsertObject(s, page, twins[k], uses[k].index);
                remap[uses[k].obj] = twins[k];
                swapped++;
            }

            auto patchParagraph = [&](Paragraph& p) {
                for (OwnedObject& oo : p.objects) {
                    auto m = remap.find(oo.object);
                    if (m != remap.end()) oo.object = m->second;
                }
                for (ParaRun& r : p.runs) {
                    auto m = remap.find(r.atomicObject);
                    if (m != remap.end()) r.atomicObject = m->second;
                    if (r.originalFont == victim) r.originalFont = nf;
                    if (r.boundFont == victim) r.boundFont = nf;
                    if (r.scriptFallbackFont == victim)
                        r.scriptFallbackFont = nf;
                }
            };
            if (pit != s.pages.end())
                for (Paragraph& p : pit->second.paras) patchParagraph(p);

            if (extra) patchParagraph(*extra);
            auto rc = s.fontRenderedCps.find(victim);
            if (rc != s.fontRenderedCps.end())
                s.fontRenderedCps[nf] = rc->second;
            auto uc = s.fontUniToCode.find(victim);
            if (uc != s.fontUniToCode.end()) s.fontUniToCode[nf] = uc->second;
            auto fb = s.fontBytes.find(victim);
            if (fb != s.fontBytes.end()) s.fontBytes[nf] = fb->second;
            for (auto& kv : s.docFontsByStyle)
                for (FPDF_FONT& f2 : kv.second)
                    if (f2 == victim) f2 = nf;
        }
    }
    return swapped;
#endif
}

uint32_t fontObjNum(Session& s, FPDF_FONT font) {
#ifndef __EMSCRIPTEN__
    (void)s;
    (void)font;
    return 0;
#else
    if (!s.doc || !font) return 0;
    const std::string baseName = fontBaseName(font);
    if (baseName.size() < 2) return 0;
    CPDF_IndirectObjectHolder* holder = abiValidatedHolder(s.doc);
    if (!holder) return 0;
    CPDF_Dictionary* dict = abiFontDict(s.doc, holder, font, baseName);
    if (!dict) return 0;

    const uint32_t n = abiObjNum(dict);
    return (n > 0 && n < (50u << 20)) ? n : 0;
#endif
}

int fontIsType0(Session& s, FPDF_FONT font) {
#ifndef __EMSCRIPTEN__
    (void)s;
    (void)font;
    return -1;
#else
    if (!s.doc || !font) return -1;
    const std::string baseName = fontBaseName(font);
    if (baseName.size() < 2) return -1;
    CPDF_IndirectObjectHolder* holder = abiValidatedHolder(s.doc);
    if (!holder) return -1;
    CPDF_Dictionary* dict = abiFontDict(s.doc, holder, font, baseName);
    if (!dict) return -1;
    const std::string sub = abiByteStringChars(dict->GetByteStringFor(
        fxcrt::StringViewTemplate<char>("Subtype", 7)));
    if (sub == "Type0") return 1;
    if (sub == "Type1" || sub == "TrueType" || sub == "Type3") return 0;
    return -1;
#endif
}

std::map<uint32_t, std::u16string> toUnicodeLastWins(Session& s,
                                                     FPDF_FONT font) {
    std::map<uint32_t, std::u16string> out;
#ifndef __EMSCRIPTEN__
    (void)s;
    (void)font;
    return out;
#else
    if (!s.doc || !font) return out;
    const std::string baseName = fontBaseName(font);
    if (baseName.size() < 2) return out;
    CPDF_IndirectObjectHolder* holder = abiValidatedHolder(s.doc);
    if (!holder) return out;
    CPDF_Dictionary* dict = abiFontDict(s.doc, holder, font, baseName);
    if (!dict) return out;

    fxcrt::RetainPtr<const CPDF_Stream> st = dict->GetStreamFor(
        fxcrt::StringViewTemplate<char>("ToUnicode", 9));
    if (!st.p_) return out;
    void* mem = malloc(128);
    if (!mem) return out;
    auto* acc = new (mem) CPDF_StreamAcc(st);
    acc->LoadAllDataFiltered();
    std::string text;
    const uint32_t size = acc->GetSize();
    if (size > 0 && size <= (1u << 20)) {
        const EcAbiSpan span = acc->GetSpan();
        if (span.p && span.n == size)
            text.assign(reinterpret_cast<const char*>(span.p), span.n);
    }
    acc->~CPDF_StreamAcc();
    free(mem);
    if (text.empty()) return out;

    size_t pos = 0;
    auto skipWs = [&] {
        while (pos < text.size() &&
               (text[pos] == ' ' || text[pos] == '\n' || text[pos] == '\r' ||
                text[pos] == '\t'))
            pos++;
    };
    auto hexTok = [&](std::string* tok) {
        skipWs();
        if (pos >= text.size() || text[pos] != '<') return false;
        const size_t end = text.find('>', pos);
        if (end == std::string::npos || end - pos > 65) return false;
        *tok = text.substr(pos + 1, end - pos - 1);
        pos = end + 1;
        return true;
    };
    auto hexVal = [](const std::string& h) -> int64_t {
        if (h.empty() || h.size() > 8) return -1;
        int64_t v = 0;
        for (char c : h) {
            int d;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else return -1;
            v = (v << 4) | d;
        }
        return v;
    };
    auto hexUtf16 = [&](const std::string& h) -> std::u16string {
        std::u16string r;

        if (h.size() == 2) {
            const int64_t v = hexVal(h);
            if (v >= 0) r.push_back(static_cast<char16_t>(v));
            return r;
        }
        if (h.size() % 4 != 0) return r;
        for (size_t k = 0; k + 4 <= h.size(); k += 4) {
            const int64_t v = hexVal(h.substr(k, 4));
            if (v < 0) return std::u16string();
            r.push_back(static_cast<char16_t>(v));
        }
        return r;
    };
    int entries = 0;
    while (pos < text.size() && entries < 20000) {
        const size_t bc = text.find("beginbfchar", pos);
        const size_t br = text.find("beginbfrange", pos);
        if (bc == std::string::npos && br == std::string::npos) break;
        if (bc != std::string::npos && (br == std::string::npos || bc < br)) {
            pos = bc + 11;
            std::string a, b;
            while (hexTok(&a) && hexTok(&b) && entries < 20000) {
                const int64_t code = hexVal(a);
                const std::u16string u = hexUtf16(b);
                if (code >= 0 && !u.empty()) out[static_cast<uint32_t>(code)] = u;
                entries++;
            }
        } else {
            pos = br + 12;
            std::string lo, hi, d;
            while (hexTok(&lo) && hexTok(&hi) && entries < 20000) {
                const int64_t l = hexVal(lo), h = hexVal(hi);
                skipWs();
                if (pos < text.size() && text[pos] == '[') {

                    pos++;
                    for (int64_t c = l; c <= h && c >= 0; c++) {
                        if (!hexTok(&d)) break;
                        const std::u16string u = hexUtf16(d);
                        if (!u.empty()) out[static_cast<uint32_t>(c)] = u;
                        entries++;
                    }
                    const size_t close = text.find(']', pos);
                    pos = close == std::string::npos ? text.size() : close + 1;
                } else if (hexTok(&d)) {
                    const std::u16string u0 = hexUtf16(d);
                    if (l >= 0 && h >= l && h - l < 65536 && !u0.empty()) {
                        for (int64_t c = l; c <= h; c++) {
                            std::u16string u = u0;
                            u.back() = static_cast<char16_t>(u0.back() + (c - l));
                            out[static_cast<uint32_t>(c)] = u;
                            entries++;
                        }
                    }
                } else {
                    break;
                }
            }
        }
    }
    return out;
#endif
}

}


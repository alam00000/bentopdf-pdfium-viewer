#ifndef EC_INTERNAL_H
#define EC_INTERNAL_H

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "editcore.h"
#include "fpdf_edit.h"
#include "fpdf_formfill.h"
#include "fpdf_text.h"

namespace ec {

struct RunStyle {
    std::string family;
    bool bold = false;
    bool italic = false;
    float size = 12.0f;
    uint32_t rgba = 0x000000FF;
    bool underline = false;
    bool strike = false;
    int script = 0;

    int renderMode = 0;
    uint32_t strokeRgba = 0x000000FF;
    float strokeWidth = 1.0f;
    float hScale = 1.0f;
    float rise = 0.0f;

    bool fauxBold = false;
    bool fauxItalic = false;

    bool strokes() const {
        return renderMode == 1 || renderMode == 2 || renderMode == 5 || renderMode == 6;
    }
    bool sameTypeface(const RunStyle& o) const {
        return family == o.family && bold == o.bold && italic == o.italic;
    }
    bool samePaint(const RunStyle& o) const {
        return sameTypeface(o) && size == o.size && rgba == o.rgba &&
               underline == o.underline && strike == o.strike && script == o.script &&
               renderMode == o.renderMode && hScale == o.hScale && rise == o.rise &&
               fauxBold == o.fauxBold && fauxItalic == o.fauxItalic &&
               (!strokes() || (strokeRgba == o.strokeRgba && strokeWidth == o.strokeWidth));
    }
};

struct ParaRun {
    std::u16string text;
    RunStyle style;

    FPDF_FONT originalFont = nullptr;

    bool textUnchanged = false;

    FPDF_FONT scriptFallbackFont = nullptr;

    std::vector<float> srcAdv;

    FPDF_FONT boundFont = nullptr;
    int layoutSrc = -1;
    FPDF_PAGEOBJECT atomicObject = nullptr;
    FPDF_PAGEOBJECT atomicContainer = nullptr;
    float atomicX = 0, atomicBaseline = 0, atomicW = 0;
    float atomicTop = 0, atomicH = 0;
};

struct LineInfo {
    float baseline = 0;
    float x = 0;
    float w = 0;

    float penX = 0;
    bool hasPenX = false;

    long off = 0;
};

struct OwnedObject {
    FPDF_PAGEOBJECT object = nullptr;
    FPDF_PAGEOBJECT container = nullptr;

    bool preserved = false;
};

struct ContentMark {
    std::string name;
    std::vector<std::pair<std::string, int>> intParams;
    std::vector<std::pair<std::string, std::string>> strParams;
};

struct Paragraph {
    int id = 0;

    float x = 0;
    float top = 0;
    float width = 0;
    float height = 0;
    float rotation = 0;

    bool vertical = false;
    bool hasMarker = false;

    int blockId = 0;
    ec_para_format fmt{0, 1.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0, 0};

    float srcCharSpacing = 0;

    float srcHangIndent = 0;
    float firstBaseline = 0;
    bool editable = true;

    int lockReason = 0;

    bool invisible = false;

    bool sharesObjects = false;

    std::vector<FPDF_PAGEOBJECT> flattenForms;

    std::set<FPDF_PAGEOBJECT> explodeForms;

    bool unwrapsForms = false;

    std::vector<ContentMark> marks;
    std::vector<LineInfo> lines;

    std::vector<long> pinnedBreaks;

    int pinWhy = 0;
    std::vector<ParaRun> runs;
    std::vector<OwnedObject> objects;

    struct Obstacle {
        float left = 0, right = 0, top = 0, bottom = 0;
    };
    std::vector<Obstacle> obstacles;
};

inline bool isUndecodableChar(char16_t c) {

    if (c <= 0x1F && c != 0x09 && c != 0x0A && c != 0x0D) return true;

    if (c >= 0x80 && c <= 0x9F) return true;
    if (c == 0xFFFD) return true;
    if (c >= 0xE000 && c <= 0xF8FF) return true;
    return false;
}

struct PageState {
    std::vector<Paragraph> paras;

    int pageRot = 0;
    float unrotW = 0, unrotH = 0;

    void toModel(float x, float y, float* mx, float* my) const {
        const float u = x - cropX, v = y - cropY;
        switch (((pageRot % 360) + 360) % 360) {
            case 90:  *mx = v;            *my = unrotW - u;  return;
            case 180: *mx = unrotW - u;   *my = unrotH - v;  return;
            case 270: *mx = unrotH - v;   *my = u;           return;
            default:  *mx = u;            *my = v;           return;
        }
    }

    void toUser(float mx, float my, float* x, float* y) const {
        float u = 0, v = 0;
        switch (((pageRot % 360) + 360) % 360) {
            case 90:  u = unrotW - my;  v = mx;            break;
            case 180: u = unrotW - mx;  v = unrotH - my;   break;
            case 270: u = my;           v = unrotH - mx;   break;
            default:  u = mx;           v = my;            break;
        }
        *x = u + cropX;
        *y = v + cropY;
    }

    void deltaToUser(float dx, float dy, float* ux, float* uy) const {
        switch (((pageRot % 360) + 360) % 360) {
            case 90:  *ux = -dy; *uy = dx;  return;
            case 180: *ux = -dx; *uy = -dy; return;
            case 270: *ux = dy;  *uy = -dx; return;
            default:  *ux = dx;  *uy = dy;  return;
        }
    }

    void textFrameOffset(float rot, float* ox, float* oy) const {
        float tx = 0, ty = 0;
        switch (((pageRot % 360) + 360) % 360) {
            case 90:  tx = 0;       ty = unrotW;  break;
            case 180: tx = unrotW;  ty = unrotH;  break;
            case 270: tx = unrotH;  ty = 0;       break;
            default:  *ox = 0; *oy = 0; return;
        }

        const float a = static_cast<float>(pageRot) * 3.14159265358979f / 180.0f - rot;
        const float c = std::cos(a), sn = std::sin(a);
        *ox = tx * c - ty * sn;
        *oy = tx * sn + ty * c;
    }

    struct GutterBand { float x0, x1, yTop, yBot; };
    std::vector<GutterBand> gutters;

    float cropX = 0, cropY = 0;
    Paragraph* find(int id) {
        for (auto& p : paras)
            if (p.id == id) return &p;
        return nullptr;
    }
};

struct EditOp {
    enum class Kind { Insert, Remove, Move, Matrix, ZOrder, Charcodes };
    Kind kind = Kind::Insert;
    FPDF_PAGEOBJECT object = nullptr;
    FPDF_PAGEOBJECT container = nullptr;
    int index = -1;
    float dx = 0, dy = 0;
    FS_MATRIX before{1, 0, 0, 1, 0, 0};
    FS_MATRIX after{1, 0, 0, 1, 0, 0};
    bool owned = false;

    std::vector<uint32_t> codesBefore, codesAfter;
    std::vector<float> posBefore, posAfter;
};

struct EditCommand {
    FPDF_PAGE page = nullptr;
    std::vector<EditOp> ops;
    std::vector<Paragraph> before, after;
    int nextParaIdBefore = 1, nextParaIdAfter = 1;
    std::string label;
};

struct SpellDict {
    std::set<std::string> words;
    void load(const char* data, size_t len);
    bool known(const std::string& w) const;
    bool knownWithAffix(const std::string& w) const;
    bool skippable(const std::u16string& w) const;
};

struct Session {
    FPDF_DOCUMENT doc = nullptr;

    FPDF_FORMHANDLE form = nullptr;
    FPDF_FORMFILLINFO formInfo = {};
    ec_font_provider_fn provider = nullptr;
    void* providerCtx = nullptr;
    std::map<FPDF_PAGE, PageState> pages;

    std::map<std::string, FPDF_FONT> fontCache;

    std::map<FPDF_FONT, FPDF_FONT> reembedCache;

    std::map<FPDF_FONT, std::vector<uint8_t>> fontBytes;

    std::map<std::string, FPDF_FONT> cidFontCache;

    uint32_t cidEmitSeq = 0;

    std::map<FPDF_FONT, std::set<uint32_t>> fontRenderedCps;

    FPDF_PAGE livePage = nullptr;
    int livePara = -1;
    int liveTicks = 0;

    std::set<FPDF_PAGE> saveCorrupting;

    std::set<FPDF_PAGE> saveTextOnly;

    std::set<FPDF_PAGE> fontsFragile;

    bool surgicalEnabled = true;

    std::map<std::string, std::vector<FPDF_FONT>> docFontsByStyle;

    std::map<FPDF_FONT, std::map<uint32_t, uint32_t>> fontUniToCode;

    bool flattenForms = true;
    int nextParaId = 1;

    std::vector<EditCommand> undoStack;
    std::vector<EditCommand> redoStack;
    std::unique_ptr<EditCommand> recording;
    size_t historyLimit = 60;
    int historyDepth = 0;
    SpellDict dict;

    int subsetSeq = 0;
};

std::u16string utf8ToUtf16(const char* utf8);
std::string utf16ToUtf8(const std::u16string& s);
void jsonEscapeInto(std::string& out, const std::string& utf8);

void historyBegin(Session& s, FPDF_PAGE page, const char* label);
void historyEnd(Session& s, FPDF_PAGE page);
void historyAbort(Session& s);
bool historyRecording(const Session& s);

bool historyRemoveObject(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT container,
                         FPDF_PAGEOBJECT obj);
void historyInsertObject(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj, int index);
void historyRecordMove(Session& s, FPDF_PAGEOBJECT obj, float dx, float dy);

void historyNoteMatrix(Session& s, FPDF_PAGEOBJECT obj);
void historyNoteZOrder(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj);
void historyNoteInsert(Session& s, FPDF_PAGE page, FPDF_PAGEOBJECT obj);

void historySealNotes(Session& s, FPDF_PAGE page);

bool historyUndo(Session& s, FPDF_PAGE page);
bool historyRedo(Session& s, FPDF_PAGE page);
void historyClear(Session& s);

bool historyScratchRevert(Session& s, FPDF_PAGE page);

struct HistoryStep {

    HistoryStep(Session&, FPDF_PAGE, const char*) {}
    HistoryStep(const HistoryStep&) = delete;
    HistoryStep& operator=(const HistoryStep&) = delete;
};

std::vector<size_t> readingOrder(const PageState& st);

const char* paragraphRole(const PageState& st, const Paragraph& p,
                          float pageWidth, float pageHeight);

std::string selectText(const PageState& st, float ax, float ay, float bx,
                       float by, int mode);

std::string spellCheckPage(const Session& s, const PageState& st);

PageState buildPageModel(Session& s, FPDF_PAGE page);
std::string paragraphToJson(const Paragraph& p);

bool commitParagraphSurgical(Session& s, FPDF_PAGE page, Paragraph& p,
                             const std::vector<ParaRun>& newRuns,
                             const Paragraph& formatted);

int reencodePageFonts(Session& s, FPDF_PAGE page,
                      std::map<FPDF_PAGEOBJECT, FPDF_PAGEOBJECT>* remap = nullptr);

bool pageNeedsReencode(Session& s, FPDF_PAGE page);

int dealiasPageFonts(Session& s, FPDF_PAGE page, Paragraph* extra = nullptr);

std::map<uint32_t, std::u16string> toUnicodeLastWins(Session& s,
                                                     FPDF_FONT font);

uint32_t fontObjNum(Session& s, FPDF_FONT font);
int fontIsType0(Session& s, FPDF_FONT font);

bool isRtlChar(char16_t c);

bool textIsRtl(const std::u16string& t);

bool unshapeArabicInPlace(std::u16string& t);

constexpr float kNoOxShared = -1e9f;

void unreverseGlyphClustersInPlace(std::u16string& text,
                                   const std::vector<float>& xs);

void shapeArabicInPlace(std::u16string& t, bool* prevJoins,
                        const std::function<bool(char16_t)>* canUseForm = nullptr);

std::vector<uint8_t> bidiLevels(const std::u16string& text, int baseDir);

uint32_t bidiMirrorCp(uint32_t cp);

struct ShapedGlyph {
    uint32_t gid = 0;
    uint32_t cluster = 0;
    float advance = 0;
    float dx = 0, dy = 0;
};
bool cpNeedsComplexShaping(uint32_t cp);
bool textNeedsComplexShaping(const std::u16string& t);
bool hbShapeText(const uint8_t* fontData, size_t fontSize,
                 const std::u16string& text, std::vector<ShapedGlyph>& out);
float hbMeasureText(const uint8_t* fontData, size_t fontSize,
                    const std::u16string& text);

bool hbShapesCleanly(const uint8_t* fontData, size_t fontSize,
                     const std::u16string& text, bool requireInk = false);

bool hbFontShapesArabic(const uint8_t* fontData, size_t fontSize);
struct OutlinePt {
    float x = 0, y = 0;
    bool on = true;
};
bool hbGlyphContours(const uint8_t* fontData, size_t fontSize, uint32_t gid,
                     std::vector<std::vector<OutlinePt>>& contours);

std::u16string hbGlyphNameText(const uint8_t* fontData, size_t fontSize,
                               uint32_t gid);

uint32_t hbGlyphIdForText(const uint8_t* fontData, size_t fontSize,
                          const std::u16string& want);
std::vector<uint8_t> hbSubsetFont(const uint8_t* fontData, size_t fontSize,
                                  const std::vector<uint32_t>& unicodes);
unsigned hbPickFace(const uint8_t* data, size_t size, const std::string& family,
                    bool bold, bool italic);
std::vector<uint8_t> hbExtractFace(const uint8_t* data, size_t size,
                                   unsigned index);
std::string buildToUnicodeForFont(const uint8_t* data, size_t size);
bool hbFontHasGlyph(const uint8_t* data, size_t size, uint32_t cp);
std::vector<uint8_t> withFontName(const std::vector<uint8_t>& fontBytes,
                                  const std::string& taggedFamily);

bool fontCovers(Session& s, FPDF_FONT font, const std::vector<uint32_t>& cps);

const std::vector<uint8_t>* fontBytesFor(Session& s, FPDF_FONT f);

struct CidGlyphEntry {
    uint32_t srcGid = 0;
    float advance = 0;
};
std::vector<uint8_t> buildCidEmissionFont(const uint8_t* srcFont, size_t srcSize,
                                          const std::vector<CidGlyphEntry>& entries,
                                          const std::string& familyName);

void pinSourceBreaks(const Paragraph& src, Paragraph& out);

std::vector<uint8_t> synthesizeSfnt(FPDF_FONT font, const std::set<uint32_t>& want,
                                    const std::map<uint32_t, int>* expectedAdv,
                                    bool* dishonest, bool restricted = false,
                                    const std::string& family = std::string());

bool fontLooksMono(FPDF_FONT font, const std::string& family);
bool fontLooksSerif(FPDF_FONT font, const std::string& family);

bool fontIsSubset(FPDF_FONT font);

std::string fontStyleKey(const std::string& family, bool bold, bool italic);
void registerDocFont(Session& s, FPDF_FONT font, const RunStyle& style);
FPDF_FONT resolveFont(Session& s, const RunStyle& style, FPDF_FONT preferred,
                      const std::vector<uint32_t>& codepoints,
                      bool allowSubsetReuse = false,
                      FPDF_FONT scriptFallback = nullptr,
                      FPDF_FONT avoid = nullptr);

bool objectStillOnPage(FPDF_PAGE page, FPDF_PAGEOBJECT obj);

void purgeDeadObjectHandles(FPDF_PAGE page, Paragraph& p);

bool layoutParagraph(Session& s, FPDF_PAGE page, Paragraph& p,
                     bool autoWiden = false,

                     std::string* previewJson = nullptr);

}

#endif


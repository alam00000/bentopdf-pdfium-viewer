#include "ec_internal.h"

namespace ec {
namespace {

enum Cls : uint8_t {
    L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON,
    LRE, RLE, PDF_, LRO, RLO, LRI, RLI, FSI, PDI
};

struct Range {
    uint32_t lo, hi;
    Cls cls;
};

const Range kRanges[] = {
    {0x0000, 0x0008, BN},   {0x0009, 0x0009, S},    {0x000A, 0x000A, B},
    {0x000B, 0x000B, S},    {0x000C, 0x000C, WS},   {0x000D, 0x000D, B},
    {0x000E, 0x001B, BN},   {0x001C, 0x001E, B},    {0x001F, 0x001F, S},
    {0x0020, 0x0020, WS},   {0x0021, 0x0022, ON},   {0x0023, 0x0025, ET},
    {0x0026, 0x002A, ON},   {0x002B, 0x002B, ES},   {0x002C, 0x002C, CS},
    {0x002D, 0x002D, ES},   {0x002E, 0x002F, CS},   {0x0030, 0x0039, EN},
    {0x003A, 0x003A, CS},   {0x003B, 0x0040, ON},   {0x005B, 0x0060, ON},
    {0x007B, 0x007E, ON},   {0x007F, 0x0084, BN},   {0x0085, 0x0085, B},
    {0x0086, 0x009F, BN},   {0x00A0, 0x00A0, CS},   {0x00A1, 0x00A1, ON},
    {0x00A2, 0x00A5, ET},   {0x00A6, 0x00A9, ON},   {0x00AB, 0x00AC, ON},
    {0x00AD, 0x00AD, BN},   {0x00AE, 0x00AF, ON},   {0x00B0, 0x00B1, ET},
    {0x00B2, 0x00B3, EN},   {0x00B4, 0x00B4, ON},   {0x00B6, 0x00B8, ON},
    {0x00B9, 0x00B9, EN},   {0x00BB, 0x00BF, ON},   {0x00D7, 0x00D7, ON},
    {0x00F7, 0x00F7, ON},   {0x02B9, 0x02BA, ON},   {0x02C2, 0x02CF, ON},
    {0x02D2, 0x02DF, ON},   {0x02E5, 0x02ED, ON},   {0x0300, 0x036F, NSM},
    {0x0374, 0x0375, ON},   {0x037E, 0x037E, ON},   {0x0384, 0x0385, ON},
    {0x0387, 0x0387, ON},   {0x03F6, 0x03F6, ON},   {0x0483, 0x0489, NSM},
    {0x058A, 0x058A, ON},   {0x058D, 0x058E, ON},   {0x058F, 0x058F, ET},
    {0x0591, 0x05BD, NSM},  {0x05BE, 0x05BE, R},    {0x05BF, 0x05BF, NSM},
    {0x05C0, 0x05C0, R},    {0x05C1, 0x05C2, NSM},  {0x05C3, 0x05C3, R},
    {0x05C4, 0x05C5, NSM},  {0x05C6, 0x05C6, R},    {0x05C7, 0x05C7, NSM},
    {0x05C8, 0x05FF, R},    {0x0600, 0x0605, AN},   {0x0606, 0x0607, ON},
    {0x0608, 0x0608, AL},   {0x0609, 0x060A, ET},   {0x060B, 0x060B, AL},
    {0x060C, 0x060C, CS},   {0x060D, 0x060D, AL},   {0x060E, 0x060F, ON},
    {0x0610, 0x061A, NSM},  {0x061B, 0x061B, AL},   {0x061C, 0x061C, AL},
    {0x061D, 0x064A, AL},   {0x064B, 0x065F, NSM},  {0x0660, 0x0669, AN},
    {0x066A, 0x066A, ET},   {0x066B, 0x066C, AN},   {0x066D, 0x066F, AL},
    {0x0670, 0x0670, NSM},  {0x0671, 0x06D5, AL},   {0x06D6, 0x06DC, NSM},
    {0x06DD, 0x06DD, AN},   {0x06DE, 0x06DE, ON},   {0x06DF, 0x06E4, NSM},
    {0x06E5, 0x06E6, AL},   {0x06E7, 0x06E8, NSM},  {0x06E9, 0x06E9, ON},
    {0x06EA, 0x06ED, NSM},  {0x06EE, 0x06EF, AL},   {0x06F0, 0x06F9, EN},
    {0x06FA, 0x070E, AL},   {0x070F, 0x070F, BN},   {0x0710, 0x0710, AL},
    {0x0711, 0x0711, NSM},  {0x0712, 0x072F, AL},   {0x0730, 0x074A, NSM},
    {0x074B, 0x07A5, AL},   {0x07A6, 0x07B0, NSM},  {0x07B1, 0x07BF, AL},
    {0x07C0, 0x07EA, R},    {0x07EB, 0x07F3, NSM},  {0x07F4, 0x07F5, R},
    {0x07F6, 0x07F9, ON},   {0x07FA, 0x07FF, R},    {0x0800, 0x0815, R},
    {0x0816, 0x0819, NSM},  {0x081A, 0x081A, R},    {0x081B, 0x0823, NSM},
    {0x0824, 0x0824, R},    {0x0825, 0x0827, NSM},  {0x0828, 0x0828, R},
    {0x0829, 0x082D, NSM},  {0x082E, 0x0858, R},    {0x0859, 0x085B, NSM},
    {0x085C, 0x089F, R},    {0x08A0, 0x08D2, AL},   {0x08D3, 0x0902, NSM},
    {0x093A, 0x093A, NSM},  {0x093C, 0x093C, NSM},  {0x0941, 0x0948, NSM},
    {0x094D, 0x094D, NSM},  {0x0951, 0x0957, NSM},  {0x0962, 0x0963, NSM},
    {0x0981, 0x0981, NSM},  {0x09BC, 0x09BC, NSM},  {0x09C1, 0x09C4, NSM},
    {0x09CD, 0x09CD, NSM},  {0x09E2, 0x09E3, NSM},  {0x09F2, 0x09F3, ET},
    {0x09FB, 0x09FB, ET},   {0x0A01, 0x0A02, NSM},  {0x0A3C, 0x0A3C, NSM},
    {0x0A41, 0x0A51, NSM},  {0x0A70, 0x0A71, NSM},  {0x0A75, 0x0A75, NSM},
    {0x0A81, 0x0A82, NSM},  {0x0ABC, 0x0ABC, NSM},  {0x0AC1, 0x0AC8, NSM},
    {0x0ACD, 0x0ACD, NSM},  {0x0AE2, 0x0AE3, NSM},  {0x0AF1, 0x0AF1, ET},
    {0x0B01, 0x0B01, NSM},  {0x0B3C, 0x0B3C, NSM},  {0x0B3F, 0x0B3F, NSM},
    {0x0B41, 0x0B44, NSM},  {0x0B4D, 0x0B56, NSM},  {0x0B62, 0x0B63, NSM},
    {0x0B82, 0x0B82, NSM},  {0x0BC0, 0x0BC0, NSM},  {0x0BCD, 0x0BCD, NSM},
    {0x0BF3, 0x0BF8, ON},   {0x0BF9, 0x0BF9, ET},   {0x0BFA, 0x0BFA, ON},
    {0x0C00, 0x0C00, NSM},  {0x0C3E, 0x0C40, NSM},  {0x0C46, 0x0C56, NSM},
    {0x0C62, 0x0C63, NSM},  {0x0C78, 0x0C7E, ON},   {0x0C81, 0x0C81, NSM},
    {0x0CBC, 0x0CBC, NSM},  {0x0CCC, 0x0CCD, NSM},  {0x0CE2, 0x0CE3, NSM},
    {0x0D00, 0x0D01, NSM},  {0x0D41, 0x0D44, NSM},  {0x0D4D, 0x0D4D, NSM},
    {0x0D62, 0x0D63, NSM},  {0x0DCA, 0x0DCA, NSM},  {0x0DD2, 0x0DD6, NSM},
    {0x0E31, 0x0E31, NSM},  {0x0E34, 0x0E3A, NSM},  {0x0E3F, 0x0E3F, ET},
    {0x0E47, 0x0E4E, NSM},  {0x0EB1, 0x0EB1, NSM},  {0x0EB4, 0x0EBC, NSM},
    {0x0EC8, 0x0ECD, NSM},  {0x0F18, 0x0F19, NSM},  {0x0F35, 0x0F35, NSM},
    {0x0F37, 0x0F37, NSM},  {0x0F39, 0x0F3D, ON},   {0x0F71, 0x0F7E, NSM},
    {0x0F80, 0x0F84, NSM},  {0x0F86, 0x0F87, NSM},  {0x0F8D, 0x0F97, NSM},
    {0x0F99, 0x0FBC, NSM},  {0x0FC6, 0x0FC6, NSM},  {0x102D, 0x1030, NSM},
    {0x1032, 0x1037, NSM},  {0x1039, 0x103A, NSM},  {0x103D, 0x103E, NSM},
    {0x1058, 0x1059, NSM},  {0x105E, 0x1060, NSM},  {0x1071, 0x1074, NSM},
    {0x1082, 0x1082, NSM},  {0x1085, 0x1086, NSM},  {0x108D, 0x108D, NSM},
    {0x109D, 0x109D, NSM},  {0x135D, 0x135F, NSM},  {0x1390, 0x1399, ON},
    {0x1400, 0x1400, ON},   {0x1680, 0x1680, WS},   {0x169B, 0x169C, ON},
    {0x17B7, 0x17BD, NSM},  {0x17C6, 0x17C6, NSM},  {0x17C9, 0x17D3, NSM},
    {0x17DB, 0x17DB, ET},   {0x17DD, 0x17DD, NSM},  {0x17F0, 0x17F9, ON},
    {0x1800, 0x180A, ON},   {0x180B, 0x180E, BN},   {0x18A9, 0x18A9, NSM},
    {0x1920, 0x1922, NSM},  {0x1927, 0x1928, NSM},  {0x1932, 0x1932, NSM},
    {0x1939, 0x193B, NSM},  {0x1940, 0x1945, ON},   {0x19DE, 0x19FF, ON},
    {0x1A17, 0x1A18, NSM},  {0x1A56, 0x1A60, NSM},  {0x1A62, 0x1A62, NSM},
    {0x1A65, 0x1A6C, NSM},  {0x1A73, 0x1A7F, NSM},  {0x1AB0, 0x1AFF, NSM},
    {0x1B00, 0x1B03, NSM},  {0x1B34, 0x1B34, NSM},  {0x1B36, 0x1B3A, NSM},
    {0x1B3C, 0x1B3C, NSM},  {0x1B42, 0x1B42, NSM},  {0x1B6B, 0x1B73, NSM},
    {0x1B80, 0x1B81, NSM},  {0x1BA2, 0x1BA5, NSM},  {0x1BA8, 0x1BA9, NSM},
    {0x1BAB, 0x1BAD, NSM},  {0x1BE6, 0x1BE6, NSM},  {0x1BE8, 0x1BE9, NSM},
    {0x1BED, 0x1BED, NSM},  {0x1BEF, 0x1BF1, NSM},  {0x1C2C, 0x1C33, NSM},
    {0x1C36, 0x1C37, NSM},  {0x1CD0, 0x1CD2, NSM},  {0x1CD4, 0x1CE0, NSM},
    {0x1CE2, 0x1CE8, NSM},  {0x1CED, 0x1CED, NSM},  {0x1CF4, 0x1CF4, NSM},
    {0x1CF8, 0x1CF9, NSM},  {0x1DC0, 0x1DFF, NSM},  {0x1FBD, 0x1FBD, ON},
    {0x1FBF, 0x1FC1, ON},   {0x1FCD, 0x1FCF, ON},   {0x1FDD, 0x1FDF, ON},
    {0x1FED, 0x1FEF, ON},   {0x1FFD, 0x1FFE, ON},   {0x2000, 0x200A, WS},
    {0x200B, 0x200D, BN},   {0x200E, 0x200E, L},    {0x200F, 0x200F, R},
    {0x2010, 0x2027, ON},   {0x2028, 0x2028, WS},   {0x2029, 0x2029, B},
    {0x202A, 0x202A, LRE},  {0x202B, 0x202B, RLE},  {0x202C, 0x202C, PDF_},
    {0x202D, 0x202D, LRO},  {0x202E, 0x202E, RLO},  {0x202F, 0x202F, CS},
    {0x2030, 0x2034, ET},   {0x2035, 0x2043, ON},   {0x2044, 0x2044, CS},
    {0x2045, 0x205E, ON},   {0x205F, 0x205F, WS},   {0x2060, 0x2064, BN},
    {0x2066, 0x2066, LRI},  {0x2067, 0x2067, RLI},  {0x2068, 0x2068, FSI},
    {0x2069, 0x2069, PDI},  {0x206A, 0x206F, BN},   {0x2070, 0x2070, EN},
    {0x2074, 0x2079, EN},   {0x207A, 0x207B, ES},   {0x207C, 0x207E, ON},
    {0x2080, 0x2089, EN},   {0x208A, 0x208B, ES},   {0x208C, 0x208E, ON},
    {0x20A0, 0x20CF, ET},   {0x20D0, 0x20FF, NSM},  {0x2100, 0x2101, ON},
    {0x2103, 0x2106, ON},   {0x2108, 0x2109, ON},   {0x2114, 0x2114, ON},
    {0x2116, 0x2118, ON},   {0x211E, 0x2123, ON},   {0x2125, 0x2125, ON},
    {0x2127, 0x2127, ON},   {0x2129, 0x2129, ON},   {0x212E, 0x212E, ET},
    {0x213A, 0x213B, ON},   {0x2140, 0x2144, ON},   {0x214A, 0x214D, ON},
    {0x2150, 0x215F, ON},   {0x2189, 0x218B, ON},   {0x2190, 0x2211, ON},
    {0x2212, 0x2212, ES},   {0x2213, 0x2213, ET},   {0x2214, 0x2335, ON},
    {0x237B, 0x2394, ON},   {0x2396, 0x2426, ON},   {0x2440, 0x244A, ON},
    {0x2460, 0x2487, ON},   {0x24EA, 0x26AB, ON},   {0x26AD, 0x27FF, ON},
    {0x2900, 0x2B73, ON},   {0x2B76, 0x2BFF, ON},   {0x2CE5, 0x2CEA, ON},
    {0x2CEF, 0x2CF1, NSM},  {0x2CF9, 0x2CFF, ON},   {0x2D7F, 0x2D7F, NSM},
    {0x2DE0, 0x2DFF, NSM},  {0x2E00, 0x2E5D, ON},   {0x2E80, 0x2E99, ON},
    {0x2E9B, 0x2EF3, ON},   {0x2F00, 0x2FD5, ON},   {0x2FF0, 0x2FFB, ON},
    {0x3000, 0x3000, WS},   {0x3001, 0x3004, ON},   {0x3008, 0x3020, ON},
    {0x302A, 0x302D, NSM},  {0x3030, 0x3030, ON},   {0x3036, 0x3037, ON},
    {0x303D, 0x303F, ON},   {0x3099, 0x309A, NSM},  {0x309B, 0x309C, ON},
    {0x30A0, 0x30A0, ON},   {0x30FB, 0x30FB, ON},   {0x31C0, 0x31E3, ON},
    {0x321D, 0x321E, ON},   {0x3250, 0x325F, ON},   {0x327C, 0x327E, ON},
    {0x32B1, 0x32BF, ON},   {0x32CC, 0x32CF, ON},   {0x3377, 0x337A, ON},
    {0x33DE, 0x33DF, ON},   {0x33FF, 0x33FF, ON},   {0x4DC0, 0x4DFF, ON},
    {0xA490, 0xA4C6, ON},   {0xA60D, 0xA60F, ON},   {0xA66F, 0xA672, NSM},
    {0xA674, 0xA67D, NSM},  {0xA673, 0xA673, ON},   {0xA67E, 0xA67F, ON},
    {0xA69E, 0xA69F, NSM},  {0xA6F0, 0xA6F1, NSM},  {0xA700, 0xA721, ON},
    {0xA788, 0xA788, ON},   {0xA802, 0xA802, NSM},  {0xA806, 0xA806, NSM},
    {0xA80B, 0xA80B, NSM},  {0xA825, 0xA826, NSM},  {0xA828, 0xA82B, ON},
    {0xA838, 0xA839, ET},   {0xA8C4, 0xA8C5, NSM},  {0xA8E0, 0xA8F1, NSM},
    {0xA926, 0xA92D, NSM},  {0xA947, 0xA951, NSM},  {0xA980, 0xA982, NSM},
    {0xA9B3, 0xA9B3, NSM},  {0xA9B6, 0xA9B9, NSM},  {0xA9BC, 0xA9BD, NSM},
    {0xAA29, 0xAA2E, NSM},  {0xAA31, 0xAA32, NSM},  {0xAA35, 0xAA36, NSM},
    {0xAA43, 0xAA43, NSM},  {0xAA4C, 0xAA4C, NSM},  {0xAA7C, 0xAA7C, NSM},
    {0xAAB0, 0xAAB0, NSM},  {0xAAB2, 0xAAB4, NSM},  {0xAAB7, 0xAAB8, NSM},
    {0xAABE, 0xAABF, NSM},  {0xAAC1, 0xAAC1, NSM},  {0xAAEC, 0xAAED, NSM},
    {0xAAF6, 0xAAF6, NSM},  {0xABE5, 0xABE5, NSM},  {0xABE8, 0xABE8, NSM},
    {0xABED, 0xABED, NSM},  {0xFB1D, 0xFB1D, R},    {0xFB1E, 0xFB1E, NSM},
    {0xFB1F, 0xFB28, R},    {0xFB29, 0xFB29, ES},   {0xFB2A, 0xFB4F, R},
    {0xFB50, 0xFD3D, AL},   {0xFD3E, 0xFD3F, ON},   {0xFD40, 0xFDCF, AL},
    {0xFDF0, 0xFDFC, AL},   {0xFDFD, 0xFDFD, ON},   {0xFDFE, 0xFDFF, AL},
    {0xFE00, 0xFE0F, NSM},  {0xFE10, 0xFE19, ON},   {0xFE20, 0xFE2F, NSM},
    {0xFE30, 0xFE4F, ON},   {0xFE50, 0xFE50, CS},   {0xFE51, 0xFE51, ON},
    {0xFE52, 0xFE52, CS},   {0xFE54, 0xFE54, ON},   {0xFE55, 0xFE55, CS},
    {0xFE56, 0xFE5E, ON},   {0xFE5F, 0xFE5F, ET},   {0xFE60, 0xFE61, ON},
    {0xFE62, 0xFE63, ES},   {0xFE64, 0xFE66, ON},   {0xFE68, 0xFE68, ON},
    {0xFE69, 0xFE6A, ET},   {0xFE6B, 0xFE6B, ON},   {0xFE70, 0xFEFE, AL},
    {0xFEFF, 0xFEFF, BN},   {0xFF01, 0xFF02, ON},   {0xFF03, 0xFF05, ET},
    {0xFF06, 0xFF0A, ON},   {0xFF0B, 0xFF0B, ES},   {0xFF0C, 0xFF0C, CS},
    {0xFF0D, 0xFF0D, ES},   {0xFF0E, 0xFF0F, CS},   {0xFF10, 0xFF19, EN},
    {0xFF1A, 0xFF1A, CS},   {0xFF1B, 0xFF20, ON},   {0xFF3B, 0xFF40, ON},
    {0xFF5B, 0xFF65, ON},   {0xFFE0, 0xFFE1, ET},   {0xFFE2, 0xFFE4, ON},
    {0xFFE5, 0xFFE6, ET},   {0xFFE8, 0xFFEE, ON},
};

Cls classify(uint32_t cp) {

    if (cp > 0xFFFF) {
        if (cp >= 0x10800 && cp <= 0x10FFF) return R;
        if (cp >= 0x1E800 && cp <= 0x1E8FF) return R;
        if (cp >= 0x1E900 && cp <= 0x1E95F) return R;
        if (cp >= 0x1EC70 && cp <= 0x1ECBF) return AL;
        if (cp >= 0x1EE00 && cp <= 0x1EEFF) return AL;
        if (cp >= 0x1D165 && cp <= 0x1D169) return NSM;
        if (cp >= 0x1D17B && cp <= 0x1D182) return NSM;
        if (cp >= 0x1D185 && cp <= 0x1D18B) return NSM;
        if (cp >= 0x1F300 && cp <= 0x1FBFF) return ON;
        return L;
    }

    int lo = 0, hi = static_cast<int>(sizeof(kRanges) / sizeof(kRanges[0])) - 1;
    while (lo <= hi) {
        const int mid = (lo + hi) / 2;
        if (cp < kRanges[mid].lo) hi = mid - 1;
        else if (cp > kRanges[mid].hi) lo = mid + 1;
        else return kRanges[mid].cls;
    }
    return L;
}

bool isStrong(Cls c) { return c == L || c == R || c == AL; }

struct Pair { uint32_t open, close; };
const Pair kBrackets[] = {
    {0x0028, 0x0029}, {0x005B, 0x005D}, {0x007B, 0x007D},
    {0x2045, 0x2046}, {0x207D, 0x207E}, {0x208D, 0x208E},
    {0x2308, 0x2309}, {0x230A, 0x230B}, {0x2329, 0x232A},
    {0x2768, 0x2769}, {0x276A, 0x276B}, {0x276C, 0x276D},
    {0x276E, 0x276F}, {0x2770, 0x2771}, {0x2772, 0x2773},
    {0x2774, 0x2775}, {0x27E6, 0x27E7}, {0x27E8, 0x27E9},
    {0x27EA, 0x27EB}, {0x27EC, 0x27ED}, {0x27EE, 0x27EF},
    {0x2983, 0x2984}, {0x2985, 0x2986}, {0x2987, 0x2988},
    {0x2989, 0x298A}, {0x298B, 0x298C}, {0x298D, 0x2990},
    {0x2991, 0x2992}, {0x2993, 0x2994}, {0x2995, 0x2996},
    {0x2997, 0x2998}, {0x29D8, 0x29D9}, {0x29DA, 0x29DB},
    {0x29FC, 0x29FD}, {0x2E22, 0x2E23}, {0x2E24, 0x2E25},
    {0x2E26, 0x2E27}, {0x2E28, 0x2E29}, {0x3008, 0x3009},
    {0x300A, 0x300B}, {0x300C, 0x300D}, {0x300E, 0x300F},
    {0x3010, 0x3011}, {0x3014, 0x3015}, {0x3016, 0x3017},
    {0x3018, 0x3019}, {0x301A, 0x301B}, {0xFE59, 0xFE5A},
    {0xFE5B, 0xFE5C}, {0xFE5D, 0xFE5E}, {0xFF08, 0xFF09},
    {0xFF3B, 0xFF3D}, {0xFF5B, 0xFF5D}, {0xFF5F, 0xFF60},
    {0xFF62, 0xFF63},
};

int bracketOf(uint32_t cp, bool& isOpen) {
    for (size_t i = 0; i < sizeof(kBrackets) / sizeof(kBrackets[0]); i++) {
        if (kBrackets[i].open == cp) { isOpen = true; return static_cast<int>(i); }
        if (kBrackets[i].close == cp) { isOpen = false; return static_cast<int>(i); }
    }
    return -1;
}

uint32_t mirrorOf(uint32_t cp) {
    bool open = false;
    const int b = bracketOf(cp, open);
    if (b >= 0)
        return open ? kBrackets[b].close : kBrackets[b].open;
    switch (cp) {
        case 0x003C: return 0x003E;
        case 0x003E: return 0x003C;
        case 0x00AB: return 0x00BB;
        case 0x00BB: return 0x00AB;
        case 0x2039: return 0x203A;
        case 0x203A: return 0x2039;
        case 0x2264: return 0x2265;
        case 0x2265: return 0x2264;
        default: return cp;
    }
}

}

std::vector<uint8_t> bidiLevels(const std::u16string& text, int baseDir) {
    const size_t n = text.size();
    std::vector<uint8_t> levels(n, 0);
    if (n == 0) return levels;

    std::vector<uint32_t> cps;
    std::vector<size_t> unitOfCp;
    cps.reserve(n);
    for (size_t i = 0; i < n; i++) {
        uint32_t cp = text[i];
        const size_t u0 = i;
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n && text[i + 1] >= 0xDC00 &&
            text[i + 1] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (text[i + 1] - 0xDC00);
            i++;
        }
        cps.push_back(cp);
        unitOfCp.push_back(u0);
    }
    const size_t m = cps.size();
    std::vector<Cls> cls(m);
    for (size_t i = 0; i < m; i++) cls[i] = classify(cps[i]);

    uint8_t base = 0;
    if (baseDir == 2) base = 1;
    else if (baseDir == 1) base = 0;
    else {
        int isolate = 0;
        for (size_t i = 0; i < m; i++) {
            const Cls c = cls[i];
            if (c == LRI || c == RLI || c == FSI) isolate++;
            else if (c == PDI) { if (isolate) isolate--; }
            else if (!isolate && isStrong(c)) {
                base = (c == L) ? 0 : 1;
                break;
            }
        }
    }

    struct St { uint8_t level; int overrideCls; bool isolate; };
    std::vector<St> stack;
    stack.push_back({base, -1, false});
    std::vector<uint8_t> lv(m, base);
    int overflowIso = 0, overflowEmb = 0, validIso = 0;
    auto nextOdd = [](uint8_t l) { return static_cast<uint8_t>((l + 1) | 1); };
    auto nextEven = [](uint8_t l) { return static_cast<uint8_t>((l + 2) & ~1); };
    for (size_t i = 0; i < m; i++) {
        const Cls c = cls[i];
        const St& top = stack.back();
        switch (c) {
            case RLE: case LRE: case RLO: case LRO: {
                lv[i] = top.level;
                cls[i] = BN;
                const uint8_t nl = (c == RLE || c == RLO) ? nextOdd(top.level)
                                                          : nextEven(top.level);
                if (nl <= 125 && !overflowIso && !overflowEmb) {
                    stack.push_back({nl,
                                     c == RLO ? R : c == LRO ? L : -1, false});
                } else if (!overflowIso) {
                    overflowEmb++;
                }
                break;
            }
            case LRI: case RLI: case FSI: {

                Cls eff = c;
                if (c == FSI) {
                    int depth = 1;
                    eff = LRI;
                    for (size_t j = i + 1; j < m && depth; j++) {
                        if (cls[j] == LRI || cls[j] == RLI || cls[j] == FSI) depth++;
                        else if (cls[j] == PDI) depth--;
                        else if (depth == 1 && isStrong(cls[j])) {
                            eff = (cls[j] == L) ? LRI : RLI;
                            break;
                        }
                    }
                }
                lv[i] = top.level;
                if (top.overrideCls >= 0)
                    cls[i] = static_cast<Cls>(top.overrideCls);
                else cls[i] = ON;
                const uint8_t nl =
                    (eff == RLI) ? nextOdd(top.level) : nextEven(top.level);
                if (nl <= 125 && !overflowIso && !overflowEmb) {
                    validIso++;
                    stack.push_back({nl, -1, true});
                } else {
                    overflowIso++;
                }
                break;
            }
            case PDI: {
                if (overflowIso) overflowIso--;
                else if (validIso) {
                    overflowEmb = 0;
                    while (!stack.back().isolate) stack.pop_back();
                    stack.pop_back();
                    validIso--;
                }
                lv[i] = stack.back().level;
                if (stack.back().overrideCls >= 0)
                    cls[i] = static_cast<Cls>(stack.back().overrideCls);
                else cls[i] = ON;
                break;
            }
            case PDF_: {
                lv[i] = top.level;
                cls[i] = BN;
                if (!overflowIso) {
                    if (overflowEmb) overflowEmb--;
                    else if (!top.isolate && stack.size() > 1) stack.pop_back();
                }
                break;
            }
            case B:
                lv[i] = base;
                break;
            default: {
                lv[i] = top.level;
                if (top.overrideCls >= 0 && c != BN)
                    cls[i] = static_cast<Cls>(top.overrideCls);
                break;
            }
        }
    }

    struct Run { size_t a, b; uint8_t level; Cls sos, eos; };
    std::vector<Run> runs;
    {
        size_t i = 0;
        while (i < m) {
            if (cls[i] == B) { i++; continue; }
            const size_t a = i;
            const uint8_t L0 = lv[i];
            while (i < m && lv[i] == L0 && cls[i] != B) i++;
            runs.push_back({a, i, L0, ON, ON});
        }
        for (size_t r = 0; r < runs.size(); r++) {
            const uint8_t prev = r ? runs[r - 1].level : base;
            const uint8_t next = (r + 1 < runs.size()) ? runs[r + 1].level : base;
            runs[r].sos = (std::max(prev, runs[r].level) & 1) ? R : L;
            runs[r].eos = (std::max(next, runs[r].level) & 1) ? R : L;
        }
    }

    for (const Run& run : runs) {
        auto at = [&](size_t k) -> Cls& { return cls[k]; };

        {
            Cls prev = run.sos;
            for (size_t k = run.a; k < run.b; k++) {
                if (at(k) == NSM) at(k) = (prev == LRI || prev == RLI ||
                                           prev == FSI || prev == PDI)
                                              ? ON
                                              : prev;
                if (at(k) != BN) prev = at(k);
            }
        }

        {
            Cls strong = run.sos;
            for (size_t k = run.a; k < run.b; k++) {
                if (isStrong(at(k))) strong = at(k);
                else if (at(k) == EN && strong == AL) at(k) = AN;
            }
        }

        for (size_t k = run.a; k < run.b; k++)
            if (at(k) == AL) at(k) = R;

        for (size_t k = run.a; k < run.b; k++) {
            if (at(k) != ES && at(k) != CS) continue;

            size_t p = k; bool hasP = false, hasN = false; size_t nn = k;
            while (p > run.a) { p--; if (at(p) != BN) { hasP = true; break; } }
            for (nn = k + 1; nn < run.b; nn++) if (at(nn) != BN) { hasN = true; break; }
            if (!hasP || !hasN) continue;
            if (at(k) == ES && at(p) == EN && at(nn) == EN) at(k) = EN;
            else if (at(k) == CS && at(p) == EN && at(nn) == EN) at(k) = EN;
            else if (at(k) == CS && at(p) == AN && at(nn) == AN) at(k) = AN;
        }

        for (size_t k = run.a; k < run.b; k++) {
            if (at(k) != ET) continue;
            size_t s = k, e = k;
            while (e + 1 < run.b && (at(e + 1) == ET || at(e + 1) == BN)) e++;
            bool en = false;
            if (s > run.a) {
                size_t p = s;
                while (p > run.a) { p--; if (at(p) != BN) { en = at(p) == EN; break; } }
            }
            if (!en && e + 1 < run.b) {
                for (size_t nn2 = e + 1; nn2 < run.b; nn2++)
                    if (at(nn2) != BN) { en = at(nn2) == EN; break; }
            }
            if (en)
                for (size_t q = s; q <= e; q++)
                    if (at(q) == ET) at(q) = EN;
            k = e;
        }

        for (size_t k = run.a; k < run.b; k++)
            if (at(k) == ET || at(k) == ES || at(k) == CS) at(k) = ON;

        {
            Cls strong = run.sos;
            for (size_t k = run.a; k < run.b; k++) {
                if (at(k) == L || at(k) == R) strong = at(k);
                else if (at(k) == EN && strong == L) at(k) = L;
            }
        }

        {
            struct Open { int pair; size_t pos; };
            std::vector<Open> stk;
            std::vector<std::pair<size_t, size_t>> pairs;
            for (size_t k = run.a; k < run.b; k++) {
                if (at(k) != ON) continue;

                bool open = false;
                const int b = bracketOf(cps[k], open);
                if (b < 0) continue;
                if (open) {
                    if (stk.size() < 63) stk.push_back({b, k});
                } else {
                    for (size_t s2 = stk.size(); s2 > 0; s2--) {
                        if (stk[s2 - 1].pair == b) {
                            pairs.push_back({stk[s2 - 1].pos, k});
                            stk.resize(s2 - 1);
                            break;
                        }
                    }
                }
            }
            std::sort(pairs.begin(), pairs.end());
            const Cls embDir = (run.level & 1) ? R : L;
            for (auto& [o, c2] : pairs) {
                Cls found = ON;
                for (size_t k = o + 1; k < c2; k++) {
                    Cls ck = at(k);
                    if (ck == EN || ck == AN) ck = R;
                    if (ck == L || ck == R) {
                        if (ck == embDir) { found = embDir; break; }
                        found = ck;
                    }
                }
                if (found == ON) continue;
                Cls setTo;
                if (found == embDir) {
                    setTo = embDir;
                } else {

                    Cls ctx = run.sos;
                    for (size_t k = o; k > run.a;) {
                        k--;
                        Cls ck = at(k);
                        if (ck == EN || ck == AN) ck = R;
                        if (ck == L || ck == R) { ctx = ck; break; }
                    }
                    setTo = (ctx == found) ? found : embDir;
                }
                at(o) = setTo;
                at(c2) = setTo;

            }
        }

        {
            size_t k = run.a;
            while (k < run.b) {
                if (at(k) != ON && at(k) != WS && at(k) != S &&
                    at(k) != LRI && at(k) != RLI && at(k) != FSI && at(k) != PDI) {
                    k++;
                    continue;
                }
                const size_t s = k;
                size_t e = k;
                while (e < run.b &&
                       (at(e) == ON || at(e) == WS || at(e) == S || at(e) == BN ||
                        at(e) == LRI || at(e) == RLI || at(e) == FSI ||
                        at(e) == PDI))
                    e++;
                Cls before = run.sos;
                for (size_t p = s; p > run.a;) {
                    p--;
                    Cls cp2 = at(p);
                    if (cp2 == BN) continue;
                    if (cp2 == EN || cp2 == AN) cp2 = R;
                    if (cp2 == L || cp2 == R) { before = cp2; }
                    break;
                }
                Cls after = run.eos;
                if (e < run.b) {
                    Cls cn = at(e);
                    if (cn == EN || cn == AN) cn = R;
                    after = (cn == L || cn == R) ? cn : run.eos;
                }
                const Cls fill = (before == after && (before == L || before == R))
                                     ? before
                                     : ((run.level & 1) ? R : L);
                for (size_t q = s; q < e; q++)
                    if (at(q) != BN) at(q) = fill;
                k = e;
            }
        }

        for (size_t k = run.a; k < run.b; k++) {
            const Cls c = at(k);
            uint8_t& l = lv[k];
            if ((l & 1) == 0) {
                if (c == R) l = l + 1;
                else if (c == AN || c == EN) l = l + 2;
            } else {
                if (c == L || c == EN || c == AN) l = l + 1;
            }
        }
    }

    for (size_t i = 0; i < m; i++) {
        const size_t u0 = unitOfCp[i];
        const size_t u1 = (i + 1 < m) ? unitOfCp[i + 1] : n;
        for (size_t u = u0; u < u1; u++) levels[u] = lv[i];
    }
    return levels;
}

uint32_t bidiMirrorCp(uint32_t cp) { return mirrorOf(cp); }

}


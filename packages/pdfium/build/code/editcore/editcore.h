#ifndef EDITCORE_H
#define EDITCORE_H

#include "fpdfview.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void* EC_SESSION;

typedef int (*ec_font_provider_fn)(
    void* ctx,
    const char* family,
    int bold,
    int italic,
    const unsigned int* codepoints,
    int codepoint_count,
    unsigned char** out_data,
    unsigned long* out_size);

const char* ec_version(void);
void* ec_buffer_alloc(unsigned long size);
void ec_string_free(char* s);

EC_SESSION ec_session_create(FPDF_DOCUMENT doc,
                             ec_font_provider_fn provider,
                             void* provider_ctx);
void ec_session_destroy(EC_SESSION session);

char* ec_build_page_model(EC_SESSION session, FPDF_PAGE page);

void ec_set_flatten_forms(EC_SESSION session, int enabled);

int ec_get_paragraph_objects(EC_SESSION session, FPDF_PAGE page, int para_id,
                             FPDF_PAGEOBJECT* out, int capacity);

unsigned long ec_get_run_font_data(EC_SESSION session, FPDF_PAGE page,
                                   int para_id, int run_index,
                                   unsigned char* out, unsigned long capacity);

typedef struct ec_run_in {
    const char* utf8;
    const char* family;
    int bold;
    int italic;
    float size;
    unsigned int rgba;
    int underline;
    int strike;
    int script;

    int source_run_index;

    int render_mode;
    unsigned int stroke_rgba;
    float stroke_width;
    float h_scale;
    float rise;
} ec_run_in;

typedef struct ec_para_format {
    int align;
    float line_spacing;
    float char_spacing;
    float para_spacing;
    float word_spacing;
    float first_indent;
    float hang_indent;
    int dir;
    int list_level;
} ec_para_format;

void ec_form_draw(EC_SESSION session, FPDF_PAGE page, FPDF_BITMAP bitmap,
                  int start_x, int start_y, int size_x, int size_y,
                  int rotate, int flags);

void ec_page_crop_origin(EC_SESSION session, FPDF_PAGE page, float* x,
                         float* y);

char* ec_preview_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                           const ec_run_in* runs, int run_count,
                           const ec_para_format* fmt);

char* ec_commit_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                          const ec_run_in* runs, int run_count,
                          const ec_para_format* fmt);

unsigned char* ec_render_paragraph_live(EC_SESSION session, FPDF_PAGE page,
                                        int para_id, const ec_run_in* runs,
                                        int run_count,
                                        const ec_para_format* fmt, float scale,
                                        float mx, float my, float mw, float mh,
                                        int* out_w, int* out_h);

char* ec_add_paragraph(EC_SESSION session, FPDF_PAGE page,
                       float x, float y_top, float width,
                       const ec_run_in* runs, int run_count,
                       const ec_para_format* fmt);

unsigned char* ec_synth_run_font(EC_SESSION session, FPDF_PAGE page,
                                 int para_id, int run_index,
                                 unsigned long* out_size);

char* ec_duplicate_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                             float dx, float dy);

int ec_clone_marker(EC_SESSION session, FPDF_PAGE page, int src_para_id,
                    int dst_para_id);

char* ec_document_info(FPDF_DOCUMENT doc);

char* ec_test_bidi(const char* utf8, int base_dir);
char* ec_test_arabic(const char* utf8, int mode);

int ec_move_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                      float dx, float dy);

char* ec_resize_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id,
                          float new_width);

int ec_delete_paragraph(EC_SESSION session, FPDF_PAGE page, int para_id);

void ec_history_begin(EC_SESSION session, FPDF_PAGE page, const char* label);
void ec_history_end(EC_SESSION session, FPDF_PAGE page);

int ec_history_undo(EC_SESSION session, FPDF_PAGE page);
int ec_history_redo(EC_SESSION session, FPDF_PAGE page);

int ec_history_depth(EC_SESSION session, int which);

void ec_history_clear(EC_SESSION session);

void ec_history_note_matrix(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj);
void ec_history_note_zorder(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj);
void ec_history_note_insert(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj);
int ec_history_remove_object(EC_SESSION session, FPDF_PAGE page, FPDF_PAGEOBJECT obj);

char* ec_page_text_json(EC_SESSION session, FPDF_PAGE page);

void ec_page_transform(EC_SESSION session, FPDF_PAGE page, float* out6);

int ec_spell_load(EC_SESSION session, const char* data, int len);

char* ec_spell_check_page(EC_SESSION session, FPDF_PAGE page);

char* ec_select_text(EC_SESSION session, FPDF_PAGE page,
                     float x0, float y0, float x1, float y1, int mode);

char* ec_build_page_model_region(EC_SESSION session, FPDF_PAGE page,
                                 float x, float y, float w, float h);

int ec_reencode_page_fonts(EC_SESSION session, FPDF_PAGE page);

int ec_dealias_page_fonts(EC_SESSION session, FPDF_PAGE page);

void ec_set_surgical(EC_SESSION session, int enabled);

char* ec_last_splice_plan(EC_SESSION session, FPDF_PAGE page);

void ec_mark_fonts_fragile(EC_SESSION session, FPDF_PAGE page);

int ec_page_has_cid_fonts(EC_SESSION session, FPDF_PAGE page);

int ec_page_regen_is_lossy(EC_SESSION session, FPDF_PAGE page, int page_index);

char* ec_page_text_state(EC_SESSION session, FPDF_PAGE page);

int ec_normalize_page_paint(FPDF_PAGE page);

unsigned char* ec_save_document(FPDF_DOCUMENT doc, int flags,
                                unsigned long* out_size);

#ifdef __cplusplus
}
#endif

#endif


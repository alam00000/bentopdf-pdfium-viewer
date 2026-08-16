# BentoPDF PDF Viewer

The PDF rendering and editing engine behind [BentoPDF](https://www.bentopdf.com) —
a framework-agnostic viewer running PDFium in WebAssembly, entirely in the browser.

This is a fork of [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer)
(© CloudPDF LTD, Apache-2.0), maintained on our own roadmap.

## Features

Annotations, true redaction, search, text selection, zoom, rotation,
virtualized scrolling with tile rendering, and form filling — as tree-shakable
plugins, usable from React, Vue, Svelte, Preact, or vanilla JS.

## Development

```bash
pnpm install
pnpm build
pnpm dev
```

`packages/` holds the SDK, `examples/` per-framework integrations.

## License

[AGPL-3.0](LICENSE). Includes Apache-2.0 code from EmbedPDF — hence
[`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0), [`NOTICE`](NOTICE), and the
per-package `LICENSE` files, retained as Apache-2.0 requires. BentoPDF's own
contributions are also available under commercial terms.

Upstream's CloudPDF server and marketing site are not part of this repository.

Rendering by [PDFium](https://pdfium.googlesource.com/pdfium/) (Apache-2.0), a
Google project. "EmbedPDF" and "CloudPDF" are brand names of CloudPDF LTD; no
trademark rights are granted here and this project is not affiliated with
either company.

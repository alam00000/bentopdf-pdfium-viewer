# BentoPDF PDF Viewer

The PDF rendering and editing engine behind [BentoPDF](https://www.bentopdf.com) —
a framework-agnostic viewer running PDFium in WebAssembly, entirely in the browser.

This is a fork of [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer)
(© CloudPDF, MIT), maintained on our own roadmap.

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

[AGPL-3.0](LICENSE). Includes MIT code from EmbedPDF — see
[`LICENSE-MIT`](LICENSE-MIT) and [`NOTICE`](NOTICE), retained as the MIT
License requires. BentoPDF's own contributions are also available under
commercial terms.

Rendering by [PDFium](https://pdfium.googlesource.com/pdfium/) (Apache-2.0), a
Google project. "EmbedPDF" and "CloudPDF" are brand names of CloudPDF; no
trademark rights are granted here and this project is not affiliated with
either company.

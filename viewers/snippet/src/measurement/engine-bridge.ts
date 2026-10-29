import type { PluginRegistry } from '@embedpdf/core';
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';

let registryRef: PluginRegistry | null = null;

export function setMeasurementRegistry(registry: PluginRegistry | null): void {
  registryRef = registry;
}

export function engineFor(
  documentId: string,
): { engine: PdfEngine; doc: PdfDocumentObject } | null {
  if (!registryRef) return null;
  const doc = registryRef.getStore().getState().core.documents[documentId]?.document;
  if (!doc) return null;
  return { engine: registryRef.getEngine(), doc };
}

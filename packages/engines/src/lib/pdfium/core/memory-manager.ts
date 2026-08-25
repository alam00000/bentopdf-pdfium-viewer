import { WasmPointer } from '../types/branded';
import { LIMITS } from '../constants/limits';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { Logger } from '@embedpdf/models';

const LOG_SOURCE = 'PDFiumEngine';
const LOG_CATEGORY = 'MemoryManager';

interface Allocation {
  ptr: WasmPointer;
  size: number;
  timestamp: number;
  stack?: string;
}

export class MemoryManager {
  private allocations = new Map<number, Allocation>();
  private totalAllocated = 0;

  constructor(
    private pdfiumModule: WrappedPdfiumModule,
    private logger: Logger,
  ) {}

  /**
   * Allocate memory with tracking and validation
   */
  malloc(size: number): WasmPointer {
    // Check total memory usage
    if (this.totalAllocated + size > LIMITS.MEMORY.MAX_TOTAL_MEMORY) {
      throw new Error(
        `Total memory usage would exceed limit: ` +
          `${this.totalAllocated + size} > ${LIMITS.MEMORY.MAX_TOTAL_MEMORY}`,
      );
    }

    const ptr = this.pdfiumModule.pdfium._malloc(size);

    if (!ptr) {
      throw new Error(`Failed to allocate ${size} bytes`);
    }

    // Track allocation
    const allocation: Allocation = {
      ptr: WasmPointer(ptr),
      size,
      timestamp: Date.now(),
      stack: this.logger.isEnabled('debug') ? new Error().stack : undefined,
    };

    this.allocations.set(ptr, allocation);
    this.totalAllocated += size;

    return WasmPointer(ptr);
  }

  /**
   * Free memory with validation
   */
  free(ptr: WasmPointer): void {
    const allocation = this.allocations.get(ptr);
    if (!allocation) {
      this.logger.warn(LOG_SOURCE, LOG_CATEGORY, `Freeing untracked pointer: ${ptr}`);
    } else {
      this.totalAllocated -= allocation.size;
      this.allocations.delete(ptr);
    }

    this.pdfiumModule.pdfium._free(ptr);
  }

  /**
   * Get memory statistics
   */
  getStats() {
    return {
      totalAllocated: this.totalAllocated,
      allocationCount: this.allocations.size,
      allocations: this.logger.isEnabled('debug') ? Array.from(this.allocations.values()) : [],
    };
  }

  /**
   * Check for memory leaks
   */
  checkLeaks(): void {
    if (this.allocations.size > 0) {
      this.logger.warn(
        LOG_SOURCE,
        LOG_CATEGORY,
        `Potential memory leak: ${this.allocations.size} unfreed allocations`,
      );

      for (const [ptr, alloc] of this.allocations) {
        this.logger.warn(LOG_SOURCE, LOG_CATEGORY, `  - ${ptr}: ${alloc.size} bytes`, alloc.stack);
      }
    }
  }
}

/**
 * Spatial hash grid for fast O(1) proximity lookups.
 * Divides the arena into cells and buckets entity IDs by position.
 */
export class SpatialGrid {
  private cellSize: number;
  private cells: Map<string, string[]>;

  constructor(cellSize: number = 300) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  private getCellKey(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(id: string, x: number, y: number): void {
    const key = this.getCellKey(x, y);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push(id);
  }

  /**
   * Insert a snake's body segments into the grid.
   * Uses stride to skip segments for performance (every Nth segment).
   */
  insertSegments(id: string, segments: { x: number; y: number }[], stride: number = 5): void {
    for (let i = 0; i < segments.length; i += stride) {
      this.insert(id, segments[i].x, segments[i].y);
    }
  }

  /**
   * Get all unique IDs in the same cell or adjacent cells (3x3 neighborhood).
   */
  getNearby(x: number, y: number): string[] {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const result: string[] = [];
    const seen = new Set<string>();

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = `${cx + dx},${cy + dy}`;
        const cell = this.cells.get(key);
        if (cell) {
          for (const id of cell) {
            if (!seen.has(id)) {
              seen.add(id);
              result.push(id);
            }
          }
        }
      }
    }

    return result;
  }
}

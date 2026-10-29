import { readFile } from 'node:fs/promises';
import { readSheetFromBuffer } from '~/services/lecture/sheet';

export async function readSheet(filePath: string): Promise<string[][]> {
  const buffer = await readFile(filePath);
  return readSheetFromBuffer(buffer);
}

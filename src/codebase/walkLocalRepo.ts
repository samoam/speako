import * as fs from 'fs';
import * as path from 'path';

// Same allowlist/denylist as rag-mcp-server's Python repo_walk.py, kept
// consistent across both projects rather than inventing a second convention.
const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  '.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.rb', '.php', '.md', '.mdx', '.txt', '.yaml', '.yml',
  '.json', '.toml', '.sh', '.sql', '.html', '.css',
]);

const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'vendor', 'venv', '.venv',
  '__pycache__', '.pytest_cache', 'target', 'bin', 'obj', '.next', '.nuxt',
  'coverage', '.idea', '.vscode',
]);

const MAX_FILE_BYTES = 500_000;
const MAX_TOTAL_BYTES = 20_000_000;
const MAX_FILES = 2000;

export interface WalkedFile {
  relativePath: string;
  content: string;
}

export interface WalkResult {
  files: WalkedFile[];
  truncated: boolean;
}

/**
 * Pure local filesystem read — no cloning, no network. Deliberately mirrors
 * rag-mcp-server's repo_walk.py caps/exclusions so behavior is predictable
 * across both "index a repo" features in this project.
 */
export function walkLocalRepo(rootPath: string): WalkResult {
  const files: WalkedFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries.filter((e) => e.isDirectory() && !EXCLUDED_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const fileEntries = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of fileEntries) {
      if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }

      const ext = path.extname(entry.name);
      if (!DEFAULT_INCLUDE_EXTENSIONS.has(ext)) continue;

      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue; // binary/unreadable — skip, same as a UnicodeDecodeError on the Python side
      }

      files.push({ relativePath: path.relative(rootPath, fullPath).split(path.sep).join('/'), content });
      totalBytes += stat.size;
    }

    for (const dirEntry of dirs) {
      walk(path.join(dir, dirEntry.name));
      if (truncated) return;
    }
  }

  walk(rootPath);
  return { files, truncated };
}

import { db } from './db';

export interface Person {
  id: number;
  displayName: string;
  email: string | null;
  role: string | null;
  position: string | null;
  team: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPersonInput {
  displayName: string;
  email?: string | null;
  role?: string | null;
  position?: string | null;
  team?: string | null;
  notes?: string | null;
}

function mapRow(r: any): Person {
  return {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    role: r.role,
    position: r.position,
    team: r.team,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Thrown instead of the raw SQLite UNIQUE-constraint error so routes/callers get a message worth showing the user. */
export class DuplicatePersonError extends Error {}

export function getAllPeople(): Person[] {
  const rows = db.prepare('SELECT * FROM people ORDER BY display_name COLLATE NOCASE ASC').all() as any[];
  return rows.map(mapRow);
}

export function getPersonById(id: number): Person | undefined {
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Case-insensitive — the same collation the unique index uses — so "alice smith" and "Alice Smith" are treated as the same person for both direct duplicate checks and suggestion filtering. */
export function personExists(displayName: string): boolean {
  const row = db.prepare('SELECT 1 FROM people WHERE display_name = ? COLLATE NOCASE').get(displayName);
  return !!row;
}

export function createPerson(input: UpsertPersonInput): Person {
  try {
    const result = db
      .prepare(
        `INSERT INTO people (display_name, email, role, position, team, notes)
         VALUES (@displayName, @email, @role, @position, @team, @notes)`
      )
      .run({
        displayName: input.displayName,
        email: input.email ?? null,
        role: input.role ?? null,
        position: input.position ?? null,
        team: input.team ?? null,
        notes: input.notes ?? null,
      });
    return getPersonById(result.lastInsertRowid as number)!;
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') {
      throw new DuplicatePersonError(`"${input.displayName}" is already in your people directory.`);
    }
    throw err;
  }
}

export function updatePerson(id: number, input: Partial<UpsertPersonInput>): Person | undefined {
  const existing = getPersonById(id);
  if (!existing) return undefined;
  try {
    db.prepare(
      `UPDATE people SET
         display_name = @displayName,
         email = @email,
         role = @role,
         position = @position,
         team = @team,
         notes = @notes,
         updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      id,
      displayName: input.displayName ?? existing.displayName,
      email: input.email !== undefined ? input.email : existing.email,
      role: input.role !== undefined ? input.role : existing.role,
      position: input.position !== undefined ? input.position : existing.position,
      team: input.team !== undefined ? input.team : existing.team,
      notes: input.notes !== undefined ? input.notes : existing.notes,
    });
  } catch (err: any) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') {
      throw new DuplicatePersonError(`"${input.displayName ?? existing.displayName}" is already in your people directory.`);
    }
    throw err;
  }
  return getPersonById(id);
}

export function deletePerson(id: number): void {
  db.prepare('DELETE FROM people WHERE id = ?').run(id);
}

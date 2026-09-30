import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPerson,
  updatePerson,
  deletePerson,
  getAllPeople,
  getPersonById,
  personExists,
  DuplicatePersonError,
} from '../src/storage/peopleRepository';

test('createPerson: round-trips via getPersonById, defaults optional fields to null', () => {
  const person = createPerson({ displayName: 'Alice Example' });
  assert.equal(person.displayName, 'Alice Example');
  assert.equal(person.email, null);
  assert.equal(person.role, null);
  assert.deepEqual(getPersonById(person.id), person);
});

test('createPerson: stores role/position/team/notes when provided', () => {
  const person = createPerson({
    displayName: 'Bob Example',
    email: 'bob@example.com',
    role: 'Backend Engineer',
    position: 'Team Lead',
    team: 'Platform',
    notes: 'Prefers async updates',
  });
  assert.equal(person.role, 'Backend Engineer');
  assert.equal(person.position, 'Team Lead');
  assert.equal(person.team, 'Platform');
  assert.equal(person.notes, 'Prefers async updates');
});

test('createPerson: rejects a duplicate display name (case-insensitive) with DuplicatePersonError', () => {
  createPerson({ displayName: 'Carol Example' });
  assert.throws(() => createPerson({ displayName: 'carol example' }), DuplicatePersonError);
});

test('personExists: case-insensitive membership check', () => {
  createPerson({ displayName: 'Dave Example' });
  assert.equal(personExists('dave example'), true);
  assert.equal(personExists('DAVE EXAMPLE'), true);
  assert.equal(personExists('Someone Else Entirely'), false);
});

test('updatePerson: partial update leaves unspecified fields untouched', () => {
  const person = createPerson({ displayName: 'Erin Example', role: 'QA Engineer', team: 'Quality' });
  const updated = updatePerson(person.id, { position: 'Senior' });
  assert.equal(updated?.role, 'QA Engineer');
  assert.equal(updated?.team, 'Quality');
  assert.equal(updated?.position, 'Senior');
});

test('updatePerson: returns undefined for an unknown id', () => {
  assert.equal(updatePerson(999999, { role: 'x' }), undefined);
});

test('updatePerson: renaming to an already-taken display name throws DuplicatePersonError', () => {
  createPerson({ displayName: 'Frank Example' });
  const other = createPerson({ displayName: 'Grace Example' });
  assert.throws(() => updatePerson(other.id, { displayName: 'Frank Example' }), DuplicatePersonError);
});

test('deletePerson: removes the row', () => {
  const person = createPerson({ displayName: 'Heidi Example' });
  deletePerson(person.id);
  assert.equal(getPersonById(person.id), undefined);
});

test('getAllPeople: sorted alphabetically, case-insensitive', () => {
  createPerson({ displayName: 'zed Example Sort Test' });
  createPerson({ displayName: 'Amy Example Sort Test' });
  const names = getAllPeople()
    .map((p) => p.displayName)
    .filter((n) => n.includes('Example Sort Test'));
  assert.deepEqual(names, ['Amy Example Sort Test', 'zed Example Sort Test']);
});

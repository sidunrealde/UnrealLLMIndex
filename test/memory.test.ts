import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineProvider } from '../src/engineContext';
import { EngineInstall, locateEngine } from '../src/engine/locate';
import { syncEngineIndex } from '../src/engine/sync';
import { ProjectIndex } from '../src/indexer';
import { checkNote, formatNote, MemoryStore, notesAbout, parseNote, renderMemorySection, resolveAnchors } from '../src/memory';
import { limitsFor, runTool, ToolContext } from '../src/tools';
import { copyFixture, SAMPLE_GAME } from './fixtures';

const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');
const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
};

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('note files', () => {
    it('round-trips through the Markdown format', () => {
        const note = {
            id: 'k3f9a2',
            kind: 'task' as const,
            status: 'open' as const,
            about: ['AActor::BeginPlay', 'Source/Game/Actor.cpp'],
            fingerprints: { 'AActor::BeginPlay': 'abc123' },
            created: '2026-09-29T10:00:00.000Z',
            updated: '2026-09-29T11:00:00.000Z',
            source: '@unreal',
            text: 'Finish the stair generator.\n\nIt stops at the first landing.',
            file: 'k3f9a2-finish-the-stair-generator.md',
        };
        const text = formatNote(note);
        expect(text.startsWith('---\nid: k3f9a2\nkind: task\nstatus: open\nabout: ["AActor::BeginPlay","Source/Game/Actor.cpp"]\n')).toBe(true);
        expect(parseNote(text, note.file)).toEqual(note);
        // Git may convert the file to CRLF
        expect(parseNote(text.replace(/\n/g, '\r\n'), note.file)).toEqual(note);
    });

    it('reads hand-written notes leniently', () => {
        const plain = parseNote('Always rebuild the nav mesh after moving walls.\n', 'navmesh.md', new Date('2026-09-01T00:00:00Z'));
        expect(plain).toMatchObject({ id: 'navmesh', kind: 'fact', about: [], text: 'Always rebuild the nav mesh after moving walls.', updated: '2026-09-01T00:00:00.000Z' });
        const yamlish = parseNote('---\nkind: gotcha   # careful\nabout: UHouseSubsystem, HouseActor.cpp\n---\nBody', 'x.md');
        expect(yamlish).toMatchObject({ id: 'x', kind: 'gotcha', about: ['UHouseSubsystem', 'HouseActor.cpp'], text: 'Body' });
        expect(parseNote('---\nkind: bogus\n---\nText', 'y.md').kind).toBe('fact');
    });
});

describe('MemoryStore', () => {
    it('adds, finds, updates and removes notes, one file each', () => {
        const dir = path.join(tempDir('ue-llm-memory-'), '.llm-memory');
        const store = new MemoryStore(dir);
        expect(store.list()).toEqual([]);

        const a = store.add({ text: 'Layout generation goes through UHouseSubsystem, never FLayoutBuilder directly!', kind: 'decision', about: ['UHouseSubsystem'], fingerprints: {} });
        const b = store.add({ text: 'Finish stairs', kind: 'task', about: [], fingerprints: {} });
        expect(a.id).toMatch(/^[0-9a-z]{6}$/);
        expect(a.id).not.toBe(b.id);
        expect(a.file).toBe(`${a.id}-layout-generation-goes-through-uhousesubsystem.md`);
        expect(b).toMatchObject({ kind: 'task', status: 'open' });
        expect(fs.readdirSync(dir).sort()).toEqual(['README.md', a.file, b.file].sort());
        expect(store.list().map(n => n.id).sort()).toEqual([a.id, b.id].sort());
        expect(store.get(a.id.slice(0, 4))?.id).toBe(a.id);
        expect(store.get(`[${b.id}]`)?.id).toBe(b.id);

        const done = store.update(b.id, { status: 'done' });
        expect(done).toMatchObject({ status: 'done', text: 'Finish stairs' });
        expect(store.list()[0].id).toBe(b.id);

        store.remove(a.id);
        expect(store.list().map(n => n.id)).toEqual([b.id]);
        expect(() => store.remove('nope')).toThrow(/No note with id "nope"/);
    });

    it('picks up notes edited or added outside the store', () => {
        const dir = tempDir('ue-llm-memory-');
        const store = new MemoryStore(dir);
        const note = store.add({ text: 'Original', kind: 'fact', about: [], fingerprints: {} });
        fs.writeFileSync(path.join(dir, note.file), fs.readFileSync(path.join(dir, note.file), 'utf8').replace('Original', 'Edited by hand, and longer'));
        fs.writeFileSync(path.join(dir, 'team-note.md'), 'Written by a teammate.');
        expect(store.list().map(n => n.text).sort()).toEqual(['Edited by hand, and longer', 'Written by a teammate.']);
    });
});

describe('anchors', () => {
    const cacheDir = tempDir('ue-llm-memory-cache-');
    let project: ProjectIndex;
    let engine: EngineProvider;
    let root: string;

    beforeAll(async () => {
        root = path.join(tempDir('ue-llm-memory-project-'), 'SampleGame');
        copyFixture(SAMPLE_GAME, root);
        // Windows checkouts (like GitHub's runners) have CRLF line endings; test with those everywhere
        for (const rel of ['Source/SampleGame/Public/SampleCharacter.h', 'Source/SampleGame/Private/SampleCharacter.cpp']) {
            const file = path.join(root, rel);
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
        }
        project = new ProjectIndex(root);
        project.refresh(true);
        const install = locateEngine('', root, { override: FAKE_ENGINE }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir, jobs: 1 });
        engine = new EngineProvider({ project, cacheDir, install });
    });

    afterAll(() => engine.dispose());

    it('resolves project symbols, engine symbols and files, and keeps unknown names as tags', () => {
        const resolved = resolveAnchors({ project, engine }, ['ApplyDamage', 'ACharacter::Jump', 'SampleCharacter.h', 'Interact', 'the save system']);
        expect(resolved.about).toEqual([
            'ASampleCharacter::ApplyDamage',
            'ACharacter::Jump',
            'Source/SampleGame/Public/SampleCharacter.h',
            'Interact',
            'the save system',
        ]);
        expect(Object.keys(resolved.fingerprints)).toEqual(['ASampleCharacter::ApplyDamage', 'ACharacter::Jump', 'Source/SampleGame/Public/SampleCharacter.h']);
        expect(resolved.notes).toEqual([
            '"Interact" matches ASampleCharacter::Interact, ISampleInteractable::Interact; use a qualified name',
            '"the save system" isn\'t a symbol or file in the project or engine',
        ]);
    });

    it('flags notes whose code changed or disappeared, until they are confirmed', async () => {
        const memory = new MemoryStore(path.join(root, '.llm-memory'));
        const ctx: ToolContext = { project, engine, memory, limits: limitsFor() };
        const saved = await runTool('remember', { text: 'ApplyDamage clamps Amount to [0, 1] first.', kind: 'gotcha', about: ['ApplyDamage', 'Clamp01'] }, ctx);
        expect(saved.text).toMatch(/^Saved gotcha \[\w{6}\] to \.llm-memory\/\w{6}-applydamage-clamps-amount-to-0-1\.md, about ASampleCharacter::ApplyDamage, Clamp01\.$/);
        const note = memory.list()[0];
        expect(checkNote(ctx, note)).toEqual({ changed: [], missing: [] });

        // Whitespace-only edits don't count as changes
        const cpp = path.join(root, 'Source/SampleGame/Private/SampleCharacter.cpp');
        const original = fs.readFileSync(cpp, 'utf8');
        fs.writeFileSync(cpp, original.replace('InStats.Health -= Clamp01(Amount);', 'InStats.Health  -=  Clamp01(Amount);'));
        project.refresh(true);
        expect(checkNote(ctx, note).changed).toEqual([]);

        fs.writeFileSync(cpp, original.replace('InStats.Health -= Clamp01(Amount);', 'InStats.Health -= Amount;'));
        project.refresh(true);
        expect(checkNote(ctx, note)).toEqual({ changed: ['ASampleCharacter::ApplyDamage'], missing: [] });
        expect((await runTool('recall', { about: 'ASampleCharacter' }, ctx)).text).toContain(
            '[may be outdated: ASampleCharacter::ApplyDamage changed since',
        );

        const confirmed = await runTool('update_note', { id: note.id }, ctx);
        expect(confirmed.text).toContain('Confirmed against the current code.');
        expect(checkNote(ctx, memory.get(note.id)!)).toEqual({ changed: [], missing: [] });

        const header = path.join(root, 'Source/SampleGame/Public/SampleCharacter.h');
        fs.writeFileSync(header, fs.readFileSync(header, 'utf8').replace(/\n[^\n]*void ApplyDamage\([^\n]*\n/, '\n'));
        fs.writeFileSync(cpp, fs.readFileSync(cpp, 'utf8').replace(/void ASampleCharacter::ApplyDamage[\s\S]*?\r?\n}\r?\n/, ''));
        project.refresh(true);
        expect(checkNote(ctx, memory.get(note.id)!).missing).toEqual(['ASampleCharacter::ApplyDamage']);
    });

    it('finds notes about a symbol, its class, or its members, and summarizes memory for the index', () => {
        const memory = new MemoryStore(tempDir('ue-llm-memory-'));
        const ctx = { project, engine };
        memory.add({ text: 'Open: stairs', kind: 'task', about: ['ASampleCharacter'], fingerprints: {} });
        memory.add({ text: 'Jump is engine-driven', kind: 'fact', about: ['ACharacter::Jump'], fingerprints: {} });
        const notes = memory.list();
        expect(notesAbout(notes, ['ACharacter'], { members: true }).map(n => n.text)).toEqual(['Jump is engine-driven']);
        expect(notesAbout(notes, ['acharacter::jump']).length).toBe(1);
        expect(notesAbout(notes, ['ACharacter']).length).toBe(0);

        const section = renderMemorySection(ctx, memory).join('\n');
        expect(section).toMatch(/^## Project memory\n2 notes in \.llm-memory\/, kept across sessions/);
        expect(section).toMatch(/Open tasks \(1\):\n- \[\w{6}\] task \(open\), \d{4}-\d\d-\d\d: Open: stairs — about ASampleCharacter/);
        expect(section).toMatch(/Latest decisions, facts and gotchas:\n- \[\w{6}\] fact, .*: Jump is engine-driven — about ACharacter::Jump/);
        expect(renderMemorySection(ctx, new MemoryStore(tempDir('ue-llm-empty-'))).join('\n')).toContain('No notes yet.');
    });
});

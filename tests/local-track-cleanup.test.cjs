/* Run with Node >= 22: node --test tests/local-track-cleanup.test.cjs */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const test = require('node:test');

// Exercise the real thunks without loading React Native or the WebRTC runtime.
const source = readFileSync(`${__dirname}/../react/features/base/tracks/actions.any.ts`, 'utf8');
const names = [ 'destroyLocalTracks', '_cancelGUMProcesses', '_disposeAndRemoveTracks', '_disposeTracks' ];
const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n/**', start);

    assert.ok(start >= 0 && end > start, `Missing function ${name}`);

    return stripTypeScriptTypes(source.slice(start, end));
}).join('\n');

function setup(initialTracks) {
    let tracks = initialTracks;
    const errors = [];
    const destroy = new Function('logger', 'JitsiTrackErrors', 'trackRemoved',
        `${functions}; return destroyLocalTracks;`)(
        { info() {}, error: (...args) => errors.push(args) },
        { TRACK_IS_DISPOSED: 'already-disposed' },
        t => ({ type: 'remove', track: t }));
    const getState = () => ({ 'features/base/tracks': tracks });
    const dispatch = action => {
        if (typeof action === 'function') {
            return action(dispatch, getState);
        }
        tracks = tracks.filter(t => t.jitsiTrack !== action.track);

        return action;
    };

    return { close: () => dispatch(destroy()), errors, add: t => tracks.push(t), getState };
}

function capture() {
    let disposed = 0;
    const jitsiTrack = { getType: () => 'audio', dispose: async () => { disposed++; } };

    return { local: true, jitsiTrack, disposed: () => disposed };
}

test('releases active capture while a canceled getUserMedia request is still pending', async () => {
    const active = capture();
    let complete;
    let canceled = false;
    const pending = new Promise(resolve => { complete = resolve; });
    const env = setup([ active, { local: true, gumProcess: {
        cancel() { canceled = true; return pending; }
    } } ]);
    const closing = env.close();

    assert.equal(canceled, true);
    assert.equal(active.disposed(), 1);
    complete();
    await closing;
});

test('old cleanup never disposes a capture added by a new meeting', async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const old = capture();
    const next = capture();
    const env = setup([ old, { local: true, gumProcess: { cancel: () => pending } } ]);
    const closing = env.close();

    env.add(next);
    complete();
    await closing;
    assert.equal(old.disposed(), 1);
    assert.equal(next.disposed(), 0);
    assert.ok(env.getState()['features/base/tracks'].includes(next));
});

test('attempts other captures and reports a disposal failure', async () => {
    const broken = capture();
    const good = capture();

    broken.jitsiTrack.dispose = async () => { throw new Error('native release failed'); };
    const env = setup([ broken, good ]);

    await assert.rejects(env.close(), /native release failed/);
    assert.equal(good.disposed(), 1);
    assert.equal(env.errors.length, 1);
    assert.ok(!env.getState()['features/base/tracks'].includes(good));
});

test('ignores already disposed captures and leaves remote tracks alone', async () => {
    const old = capture();
    const remote = { ...capture(), local: false };

    old.jitsiTrack.dispose = async () => { throw { name: 'already-disposed' }; };
    const env = setup([ old, remote ]);

    await env.close();
    assert.equal(env.errors.length, 0);
    assert.equal(remote.disposed(), 0);
});

test('a capture delivered after cancellation is disposed instead of added', async () => {
    const start = source.indexOf('function createLocalTracksA(');
    const end = source.indexOf('\n/**', start);
    const createSource = stripTypeScriptTypes(source.slice(start, end));
    let deliver;
    const gum = new Promise(resolve => { deliver = resolve; });
    const actions = [];
    const create = new Function('createLocalTracksF', 'getLocalTrack', 'getCameraFacingMode',
        'trackAdded', '_trackCreateCanceled', '_onCreateLocalTracksRejected', 'TRACK_WILL_CREATE',
        'MEDIA_TYPE', 'logger', 'JitsiTrackErrors', `${functions}\n${createSource}; return createLocalTracksA;`)(
        () => gum, () => undefined, () => 'user', t => ({ type: 'added', track: t }),
        () => ({ type: 'canceled' }), () => ({ type: 'error' }), 'creating',
        { AUDIO: 'audio', VIDEO: 'video' }, { info() {}, error() {} },
        { TRACK_IS_DISPOSED: 'already-disposed' });
    const done = create({ devices: [ 'audio' ] })(a => { actions.push(a); return a; },
        () => ({ 'features/base/tracks': [] }));

    actions[0].track.gumProcess.cancel();
    const late = capture();

    deliver([ late.jitsiTrack ]);
    await done;
    assert.equal(late.disposed(), 1);
    assert.ok(actions.some(a => a.type === 'canceled'));
    assert.ok(!actions.some(a => a.type === 'added'));
});

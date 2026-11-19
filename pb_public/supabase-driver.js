/* Little Journal — Supabase connector.
 *
 * The app was written against PocketBase. This file gives it the same small interface
 * (pb.collection(...).getFullList / create / update / delete / subscribe, pb.authStore, pb.files)
 * backed by Supabase Auth + Postgres (with the rules in supabase/schema.sql) + Storage + Realtime.
 * Only loaded when config.js says backend: "supabase".
 */
(function () {
  'use strict';
  const BUCKET = 'journal';
  const SIGN_FOR = 60 * 60 * 24 * 7;           // photo links last 7 days, refreshed by the app
  const AUTH_KEY = 'journal-supabase-auth';

  function makeError(e, fallback) {
    const err = new Error((e && (e.message || e.error_description)) || 'Something went wrong');
    let status = fallback ?? 400;
    if (!e) status = 0;
    else if (e instanceof TypeError || /fetch|network/i.test(e.message || '')) status = 0;
    else if (e.code === '23505') status = 400;                       // duplicate (e.g. hearted twice)
    else if (e.code === '42501' || e.code === 'PGRST116') status = 403;
    else if (e.code === 'PGRST301' || e.status === 401) status = 401;
    else if (e.status === 429 || /rate limit/i.test(e.message || '')) status = 429;
    else if (e.statusCode === '413' || e.status === 413 || /maximum allowed size|too large/i.test(e.message || '')) status = 413;
    else if (typeof e.status === 'number') status = e.status;
    err.status = status;
    err.response = { data: {} };
    return err;
  }

  window.makeSupabasePB = function (cfg) {
    const sb = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_KEY },
    });
    const urls = new Map();       // storage path -> signed URL
    const mediaRows = new Map();  // id -> raw row (to know which files to delete)
    let me = null;                // { id, who, name, email }
    const channels = [];

    // ---------- shapes: Supabase row <-> the record shape the app expects
    const toApp = (table, r) => {
      if (!r) return r;
      if (table === 'media') return { ...r, page: r.page || '', poster: r.poster || '', order: r.sort_order, addedAt: r.added_at };
      if (table === 'pages') return { ...r, cover: r.cover || '' };
      return { ...r };
    };
    const MEDIA_FIELDS = { kind: 'kind', page: 'page', caption: 'caption', w: 'w', h: 'h', duration: 'duration', size: 'size', name: 'name', order: 'sort_order', addedAt: 'added_at' };
    const toDb = (table, d) => {
      const o = {};
      if (table === 'pages') {
        for (const k of ['id', 'title', 'date', 'place', 'note', 'layout', 'owner']) if (k in d) o[k] = d[k];
        if ('cover' in d) o.cover = d.cover || null;
      } else if (table === 'media') {
        for (const [k, col] of Object.entries(MEDIA_FIELDS)) if (k in d) o[col] = d[k];
        if ('page' in o) o.page = o.page || null;
        for (const n of ['w', 'h', 'size']) if (n in o) o[n] = Math.round(Number(o[n]) || 0);
        for (const n of ['duration', 'sort_order', 'added_at']) if (n in o) o[n] = Number(o[n]) || 0;
      } else if (table === 'hearts') {
        for (const k of ['target', 'who']) if (k in d) o[k] = d[k];
      } else if (table === 'notes') {
        for (const k of ['id', 'target', 'who', 'text']) if (k in d) o[k] = d[k];
      } else if (table === 'meta') {
        if ('title' in d) o.title = d.title;
      } else if (table === 'profiles') {
        if ('name' in d) o.name = d.name;
      }
      return o;
    };
    const TABLE = { users: 'profiles', pages: 'pages', media: 'media', hearts: 'hearts', notes: 'notes', meta: 'meta' };

    async function sign(paths) {
      const todo = [...new Set(paths.filter(Boolean))];
      for (let i = 0; i < todo.length; i += 200) {
        const chunk = todo.slice(i, i + 200);
        const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, SIGN_FOR);
        if (error) throw makeError(error);
        for (const x of data || []) if (x.signedUrl) urls.set(x.path, x.signedUrl);
      }
    }
    const mediaPaths = r => [r.file, r.poster].filter(Boolean);

    async function loadMe(user) {
      const { data, error } = await sb.from('profiles').select('id, who, name').eq('id', user.id).maybeSingle();
      if (error) throw makeError(error);
      if (!data) { await sb.auth.signOut(); throw makeError({ message: 'Not part of this journal', status: 403 }); }
      me = { ...data, email: user.email };
      return me;
    }

    async function selectAll(table) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(table).select('*').order('created', { ascending: true, nullsFirst: true }).range(from, from + 999);
        if (error) throw makeError(error);
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out;
    }

    function collection(name) {
      const table = TABLE[name] || name;
      return {
        async getFullList(opts = {}) {
          if (table === 'profiles') {
            const { data, error } = await sb.from('profiles').select('id, who, name');
            if (error) throw makeError(error);
            return data;
          }
          if (table === 'meta') {
            const { data, error } = await sb.from('meta').select('*');
            if (error) throw makeError(error);
            return data;
          }
          const rows = await selectAll(table);
          if (table === 'media') {
            rows.forEach(r => mediaRows.set(r.id, r));
            await sign(rows.flatMap(mediaPaths));
          }
          return rows.map(r => toApp(table, r));
        },

        async authWithPassword(email, password) {
          const { data, error } = await sb.auth.signInWithPassword({ email: String(email || ''), password });
          if (error) throw makeError(error, 400);
          const rec = await loadMe(data.user);
          return { token: data.session.access_token, record: rec };
        },
        async authRefresh() {
          const { data, error } = await sb.auth.getSession();
          if (error) throw makeError(error, 401);
          if (!data.session) throw makeError({ message: 'Signed out', status: 401 });
          const rec = await loadMe(data.session.user);
          return { token: data.session.access_token, record: rec };
        },

        async create(input) {
          if (table === 'media') return createMedia(input);
          const { data, error } = await sb.from(table).insert(toDb(table, input)).select().single();
          if (error) throw makeError(error);
          return toApp(table, data);
        },

        async update(id, input) {
          if (table === 'profiles' && input && input.password) return changePassword(input);
          const { data, error } = await sb.from(table).update(toDb(table, input)).eq('id', id).select();
          if (error) throw makeError(error);
          if (!data || !data.length) throw makeError({ message: 'Not allowed', code: '42501' });
          if (table === 'media') {
            mediaRows.set(data[0].id, data[0]);
            await sign(mediaPaths(data[0]).filter(p => !urls.has(p)));
          }
          return toApp(table, data[0]);
        },

        async delete(id) {
          const row = table === 'media' ? mediaRows.get(id) : null;
          const { data, error } = await sb.from(table).delete().eq('id', id).select('id');
          if (error) throw makeError(error);
          if (!data || !data.length) throw makeError({ message: 'Not allowed', code: '42501' });
          if (row) { await sb.storage.from(BUCKET).remove(mediaPaths(row)).catch(() => {}); mediaRows.delete(id); }
          return true;
        },

        async subscribe(topic, cb) {
          const ch = sb.channel('journal-' + table + '-' + Math.random().toString(36).slice(2))
            .on('postgres_changes', { event: '*', schema: 'public', table }, async payload => {
              const action = payload.eventType === 'DELETE' ? 'delete' : payload.eventType === 'INSERT' ? 'create' : 'update';
              const row = action === 'delete' ? payload.old : payload.new;
              if (!row || !row.id) return;
              if (table === 'media') {
                if (action === 'delete') mediaRows.delete(row.id);
                else { mediaRows.set(row.id, row); try { await sign(mediaPaths(row).filter(p => !urls.has(p))); } catch (_) {} }
              }
              cb({ action, record: toApp(table, row) });
            })
            .subscribe();
          channels.push(ch);
          return () => sb.removeChannel(ch);
        },
        async unsubscribe() {},
      };
    }

    async function createMedia(fd) {
      if (!me) throw makeError({ message: 'Signed out', status: 401 });
      const get = k => (fd instanceof FormData ? fd.get(k) : fd[k]);
      const fields = {};
      for (const k of Object.keys(MEDIA_FIELDS)) { const v = get(k); if (v != null) fields[k] = v; }
      const file = get('file'), poster = get('poster');
      const extOf = f => ((f && f.name || '').match(/\.([a-z0-9]{2,5})$/i) || [, 'bin'])[1].toLowerCase();
      const uploaded = [];
      const put = async f => {
        const path = `${me.id}/${crypto.randomUUID()}.${extOf(f)}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined, upsert: false });
        if (error) throw makeError(error);
        uploaded.push(path);
        return path;
      };
      try {
        const row = toDb('media', fields);
        row.file = await put(file);
        row.poster = poster && poster.size ? await put(poster) : null;
        const { data, error } = await sb.from('media').insert(row).select().single();
        if (error) throw makeError(error);
        mediaRows.set(data.id, data);
        await sign(mediaPaths(data));
        return toApp('media', data);
      } catch (e) {
        if (uploaded.length) sb.storage.from(BUCKET).remove(uploaded).catch(() => {});
        throw e.status != null ? e : makeError(e);
      }
    }

    async function changePassword(input) {
      if (!me) throw makeError({ message: 'Signed out', status: 401 });
      const check = await sb.auth.signInWithPassword({ email: me.email, password: input.oldPassword || '' });
      if (check.error) { const e = makeError(check.error, 400); e.response.data.oldPassword = { message: 'wrong' }; throw e; }
      const { error } = await sb.auth.updateUser({ password: input.password });
      if (error) { const e = makeError(error, 400); e.response.data.password = { message: error.message }; throw e; }
      return me;
    }

    let hasSession = false;
    try { hasSession = !!localStorage.getItem(AUTH_KEY); } catch (_) {}

    return {
      kind: 'supabase',
      autoCancellation() { return this; },
      collection,
      authStore: {
        get isValid() { return !!me || hasSession; },
        get record() { return me; },
        clear() { me = null; hasSession = false; sb.auth.signOut().catch(() => {}); },
      },
      files: {
        getURL(_rec, path) { return urls.get(path) || ''; },
        async getToken() { await sign([...urls.keys()]); return ''; },
      },
      realtime: {
        async unsubscribe() { channels.splice(0).forEach(ch => sb.removeChannel(ch)); },
      },

      // sign-in screen helpers
      async journalPeople() {
        const { data, error } = await sb.rpc('journal_people');
        if (error) throw makeError(error, 0);
        return data;
      },
      async journalSetup(f) {
        const { data: ok, error: codeErr } = await sb.rpc('journal_check_code', { code: f.code });
        if (codeErr) throw makeError(codeErr, 0);
        if (!ok) throw new Error('That setup code isn’t right (or setup is already done). Check the code you put in schema.sql.');
        const people = (await this.journalPeople()).people || [];
        for (const [slot, name, email, password] of [['a', f.nameA, f.emailA, f.passwordA], ['b', f.nameB, f.emailB, f.passwordB]]) {
          if (people.some(p => p.slot === slot)) continue;
          const { data, error } = await sb.auth.signUp({ email, password, options: { data: { slot, name, setup_code: f.code } } });
          if (error) throw new Error(/database error/i.test(error.message) ? `Couldn’t create ${name}’s account. Check the setup code.` : error.message);
          if (!data.session) throw new Error('Almost there: in Supabase, open Authentication → Sign In / Providers → Email, turn OFF “Confirm email”, then try again.');
        }
        await collection('users').authWithPassword(f.emailA, f.passwordA);
        if (f.title) await sb.from('meta').update({ title: f.title }).eq('id', 1);
        return { ok: true };
      },
      maxVideoBytes: 50 * 1024 * 1024,
    };
  };
})();

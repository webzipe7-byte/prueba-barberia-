// Casa Navaja — capa de datos compartida por la página de reservas y el panel del personal.
//
// PARA QUE FUNCIONE EN APARATOS DISTINTOS:
//   1. Crea un proyecto gratis en https://supabase.com
//   2. En Supabase abre "SQL Editor", pega el contenido de supabase-setup.sql y dale Run.
//   3. En "Project Settings → API" copia el Project URL y la anon public key y pégalos aquí abajo.
//
// Mientras estén vacíos, todo funciona solo en este navegador (localStorage), como demo.
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';

(function(){
  const K = {sched:'casa-navaja-ocupados', book:'casa-navaja-reservas', rev:'casa-navaja-resenas', myRev:'casa-navaja-mis-resenas'};
  const readJSON = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch(e){ return f; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } };
  const dateKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = () => dateKey(new Date());
  const fmtDate = d => new Date(d).toLocaleDateString('es-CO', {day:'numeric', month:'short', year:'numeric'}).replace('.', '');
  const toSlots = rows => { const o = {}; rows.forEach(r => ((o[r.barbero] ||= {})[r.fecha] ||= []).push(r.hora)); return o; };
  const token = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ── Solo este navegador ──────────────────────────────────────────────
  const local = {
    online: false,
    async loadSchedule(){ return readJSON(K.sched, {updated:null, slots:{}}); },
    async loadTaken(){ return readJSON(K.book, []).map(b => ({pro:b.pro, date:b.date, time:b.time})); },
    async loadBookings(pro){ return readJSON(K.book, []).filter(b => b.pro===pro && b.date >= today()); },
    async publish(pro, mine){
      const cur = readJSON(K.sched, {slots:{}}), slots = cur.slots || {};
      if(mine && Object.keys(mine).length) slots[pro] = mine; else delete slots[pro];
      const next = {updated: Date.now(), slots};
      if(!writeJSON(K.sched, next)) throw new Error('No se pudo guardar en este navegador.');
      return next;
    },
    async book(b){
      const list = readJSON(K.book, []), sched = readJSON(K.sched, {slots:{}});
      if(list.some(x => x.pro===b.pro && x.date===b.date && x.time===b.time) || (sched.slots?.[b.pro]?.[b.date] || []).includes(b.time)) return {ok:false};
      list.push({id: token(), ...b, at: Date.now()});
      writeJSON(K.book, list);
      return {ok:true};
    },
    async cancelBooking(id){ writeJSON(K.book, readJSON(K.book, []).filter(b => b.id !== id)); },
    async loadReviews(){ return readJSON(K.rev, []); },
    async addReview(r){ const l = readJSON(K.rev, []), x = {id: token(), ...r, t: fmtDate(Date.now())}; l.push(x); writeJSON(K.rev, l); return x; },
    async deleteReview(id){ writeJSON(K.rev, readJSON(K.rev, []).filter(r => r.id !== id)); },
    isMine(){ return true; },
    onChange(cb){
      addEventListener('storage', e => { const m = {[K.sched]:'schedule', [K.book]:'bookings', [K.rev]:'reviews'}[e.key]; if(m) cb(m); });
    },
  };

  // ── Supabase (compartido entre todos los aparatos) ───────────────────
  const online = !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
  if(SUPABASE_URL && SUPABASE_ANON_KEY && !window.supabase) console.warn('Casa Navaja: no cargó la librería de Supabase; se usa el modo local.');
  const sb = online ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
  const check = ({data, error}) => { if(error) throw error; return data; };

  const remote = {
    online: true,
    async loadSchedule(pro){
      const [rows, pubs] = await Promise.all([
        sb.from('ocupados').select('barbero,fecha,hora').gte('fecha', today()).then(check),
        sb.from('publicaciones').select('barbero,actualizado').then(check),
      ]);
      const ups = pubs.filter(p => pro == null || p.barbero === pro).map(p => Date.parse(p.actualizado));
      return {updated: ups.length ? Math.max(...ups) : null, slots: toSlots(rows)};
    },
    async loadTaken(){
      const rows = check(await sb.from('turnos_tomados').select('barbero,fecha,hora').gte('fecha', today()));
      return rows.map(r => ({pro:r.barbero, date:r.fecha, time:r.hora}));
    },
    async loadBookings(pro){
      const rows = check(await sb.from('reservas').select('id,barbero,fecha,hora,nombre,celular,servicio').eq('barbero', pro).gte('fecha', today()).order('fecha').order('hora'));
      return rows.map(r => ({id:r.id, pro:r.barbero, date:r.fecha, time:r.hora, name:r.nombre, phone:r.celular, svc:r.servicio}));
    },
    async publish(pro, mine){
      const filas = [];
      for(const [fecha, horas] of Object.entries(mine || {})) horas.forEach(hora => filas.push({fecha, hora}));
      const t = check(await sb.rpc('publicar_ocupados', {p_barbero:pro, p_desde:today(), p_filas:filas}));
      return {updated: Date.parse(t), slots: {[pro]: mine || {}}};
    },
    async book(b){
      const {error} = await sb.rpc('reservar', {p_barbero:b.pro, p_fecha:b.date, p_hora:b.time, p_nombre:b.name, p_celular:b.phone, p_servicio:b.svc});
      if(!error) return {ok:true};
      if(error.code === '23505' || /ocupado/i.test(error.message)) return {ok:false};
      throw error;
    },
    async cancelBooking(id){ check(await sb.from('reservas').delete().eq('id', id)); },
    async loadReviews(){
      const rows = check(await sb.from('resenas').select('id,nombre,servicio,texto,estrellas,creada').order('creada'));
      return rows.map(r => ({id:r.id, n:r.nombre, s:r.servicio, c:r.texto, rate:r.estrellas, t:fmtDate(r.creada)}));
    },
    async addReview(r){
      const clave = token();
      const row = check(await sb.from('resenas').insert({nombre:r.n, servicio:r.s, texto:r.c, estrellas:r.rate, clave}).select('id,creada').single());
      const mineIds = readJSON(K.myRev, {}); mineIds[row.id] = clave; writeJSON(K.myRev, mineIds);
      return {id:row.id, ...r, t:fmtDate(row.creada)};
    },
    async deleteReview(id){
      const mineIds = readJSON(K.myRev, {});
      check(await sb.rpc('borrar_resena', {p_id:id, p_clave:mineIds[id] || ''}));
      delete mineIds[id]; writeJSON(K.myRev, mineIds);
    },
    isMine(id){ return id in readJSON(K.myRev, {}); },
    onChange(cb){
      const map = {ocupados:'schedule', publicaciones:'schedule', reservas:'bookings'}; // las reseñas se refrescan con el respaldo de abajo
      const ch = sb.channel('casa-navaja');
      Object.keys(map).forEach(t => ch.on('postgres_changes', {event:'*', schema:'public', table:t}, () => cb(map[t])));
      ch.subscribe();
      // Respaldo por si el tiempo real no está activo: revisa al volver a la página y cada 30 s
      addEventListener('focus', () => cb('all'));
      setInterval(() => { if(!document.hidden) cb('all'); }, 30000);
    },
  };

  window.CN = online ? remote : local;
})();

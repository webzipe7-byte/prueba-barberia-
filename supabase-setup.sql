-- Casa Navaja — configuración de la base de datos en Supabase
-- Cómo usarlo: en Supabase abre "SQL Editor" → "New query", pega TODO este archivo y dale "Run".
-- Se puede ejecutar más de una vez sin problema.
--
-- AVISO (demo): el inicio de sesión del personal es de mentira, así que estas reglas dejan
-- que cualquiera con la página lea las reservas (nombre y celular) y las cancele.
-- Antes de usarlo con clientes reales hay que activar un inicio de sesión real (Supabase Auth).

-- ── Tablas ────────────────────────────────────────────────────────────
create table if not exists public.ocupados (
  barbero  int  not null check (barbero between 0 and 20),
  fecha    date not null,
  hora     text not null check (hora ~ '^[0-2][0-9]:[0-5][0-9]$'),
  primary key (barbero, fecha, hora)
);

create table if not exists public.publicaciones (
  barbero     int primary key,
  actualizado timestamptz not null default now()
);

create table if not exists public.reservas (
  id       uuid primary key default gen_random_uuid(),
  barbero  int  not null check (barbero between 0 and 20),
  fecha    date not null,
  hora     text not null check (hora ~ '^[0-2][0-9]:[0-5][0-9]$'),
  nombre   text not null check (char_length(nombre) between 1 and 80),
  celular  text not null check (celular ~ '^[0-9]{10}$'),
  servicio text not null check (char_length(servicio) between 1 and 80),
  creada   timestamptz not null default now(),
  unique (barbero, fecha, hora)          -- evita que dos clientes tomen el mismo turno
);

create table if not exists public.resenas (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null check (char_length(nombre) between 1 and 40),
  servicio  text not null check (char_length(servicio) between 1 and 80),
  texto     text not null check (char_length(texto) between 10 and 400),
  estrellas int  not null check (estrellas between 1 and 5),
  clave     text not null,                -- secreto del autor para poder borrar su reseña
  creada    timestamptz not null default now()
);

-- La página pública solo necesita saber qué turnos están tomados, no quién los tomó
create or replace view public.turnos_tomados with (security_invoker = true) as
  select barbero, fecha, hora from public.reservas;

-- ── Permisos (Row Level Security) ─────────────────────────────────────
alter table public.ocupados      enable row level security;
alter table public.publicaciones enable row level security;
alter table public.reservas      enable row level security;
alter table public.resenas       enable row level security;

drop policy if exists "leer ocupados" on public.ocupados;
create policy "leer ocupados" on public.ocupados for select to anon, authenticated using (true);

drop policy if exists "leer publicaciones" on public.publicaciones;
create policy "leer publicaciones" on public.publicaciones for select to anon, authenticated using (true);

drop policy if exists "leer reservas" on public.reservas;
create policy "leer reservas" on public.reservas for select to anon, authenticated using (true);
drop policy if exists "cancelar reservas" on public.reservas;
create policy "cancelar reservas" on public.reservas for delete to anon, authenticated using (true);

drop policy if exists "leer resenas" on public.resenas;
create policy "leer resenas" on public.resenas for select to anon, authenticated using (true);
drop policy if exists "escribir resenas" on public.resenas;
create policy "escribir resenas" on public.resenas for insert to anon, authenticated with check (true);

-- Nadie puede leer la "clave" de las reseñas
revoke select on public.resenas from anon, authenticated;
grant select (id, nombre, servicio, texto, estrellas, creada) on public.resenas to anon, authenticated;
grant insert (nombre, servicio, texto, estrellas, clave) on public.resenas to anon, authenticated;
grant select on public.turnos_tomados to anon, authenticated;

-- ── Funciones ─────────────────────────────────────────────────────────
-- Botón "Actualizar" del panel: reemplaza las horas ocupadas futuras de un barbero
create or replace function public.publicar_ocupados(p_barbero int, p_desde date, p_filas jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  delete from ocupados where barbero = p_barbero and fecha >= p_desde;
  insert into ocupados (barbero, fecha, hora)
    select distinct p_barbero, (f->>'fecha')::date, f->>'hora'
    from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) f
    where (f->>'fecha')::date >= p_desde;
  insert into publicaciones (barbero, actualizado) values (p_barbero, t)
    on conflict (barbero) do update set actualizado = excluded.actualizado;
  return t;
end $$;

-- Reserva de un cliente: falla si el barbero marcó esa hora como ocupada o ya está tomada
create or replace function public.reservar(p_barbero int, p_fecha date, p_hora text, p_nombre text, p_celular text, p_servicio text)
returns uuid language plpgsql security definer set search_path = public as $$
declare nuevo uuid;
begin
  if exists (select 1 from ocupados where barbero = p_barbero and fecha = p_fecha and hora = p_hora) then
    raise exception 'ocupado';
  end if;
  insert into reservas (barbero, fecha, hora, nombre, celular, servicio)
    values (p_barbero, p_fecha, p_hora, p_nombre, p_celular, p_servicio)
    returning id into nuevo;
  return nuevo;
end $$;

-- Borrar una reseña: solo quien la escribió (tiene la clave guardada en su navegador)
create or replace function public.borrar_resena(p_id uuid, p_clave text)
returns void language sql security definer set search_path = public as $$
  delete from resenas where id = p_id and clave = p_clave;
$$;

grant execute on function public.publicar_ocupados(int, date, jsonb) to anon, authenticated;
grant execute on function public.reservar(int, date, text, text, text, text) to anon, authenticated;
grant execute on function public.borrar_resena(uuid, text) to anon, authenticated;

-- ── Tiempo real (la página se actualiza sola cuando hay cambios) ──────
do $$
declare t text;
begin
  foreach t in array array['ocupados', 'publicaciones', 'reservas'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

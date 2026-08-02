-- Lokalny bezpiecznik sprzeciwu (opt-out) na kontakcie.
--
-- KANONICZNA lista wykluczen lejka AMP zyje w BAZIE KALKULATORA
-- (tabela public.suppression_list, razem z reactivation_leads), bo § 8 ust. 3
-- umowy powierzenia wymaga zaprzestania komunikacji WE WSZYSTKICH KANALACH.
-- Ta kolumna jej NIE zastepuje i nie jest zrodlem prawdy dla SMS-a ani Meta CA.
--
-- Po co wiec jest: webhook WhatsAppa oddaje Meta 200 natychmiast i przetwarza
-- w next/after(), ktorego catch polyka wyjatki - Meta nigdy nie ponowi. Jesli
-- zapis miedzyprojektowy padnie mimo 3 prob, sprzeciw nie moze wyparowac.
-- Wtedy ustawiamy te flage, zeby wacrm sam nie napisal do tej osoby, a wpis
-- na liste kanoniczna dorobic recznie (log: [suppression][DO-REKONCYLIACJI]).
--
-- Innymi slowy: suppression_list = obowiazek wobec osoby i wobec AMP,
-- contacts.opted_out = ostatnia linia obrony wewnatrz tego jednego systemu.

alter table public.contacts
  add column if not exists opted_out boolean not null default false,
  add column if not exists opted_out_at timestamptz;

comment on column public.contacts.opted_out is
  'Sprzeciw wobec komunikacji. Bezpiecznik LOKALNY - zrodlem prawdy dla calego '
  'lejka jest suppression_list w bazie kalkulatora (§ 8 ust. 3 umowy powierzenia AMP).';

comment on column public.contacts.opted_out_at is
  'Kiedy odnotowano sprzeciw. Rozliczalnosc z art. 5 ust. 2 RODO.';

-- Kontakty do recznej rekoncyliacji: maja lokalny sprzeciw, ale trzeba
-- potwierdzic, ze trafily takze na liste kanoniczna.
create index if not exists contacts_opted_out_idx
  on public.contacts (opted_out_at desc) where opted_out;

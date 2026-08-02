/**
 * Zapis sprzeciwu do KANONICZNEJ listy wykluczen lejka reaktywacyjnego AMP.
 *
 * DLACZEGO TO PISZE DO INNEGO PROJEKTU SUPABASE:
 * wacrm ma wlasna baze (paspnksnzqkdnglzjxxg). Tabela `suppression_list`
 * zyje w bazie kalkulatora, razem z `reactivation_leads`. § 8 ust. 3 umowy
 * powierzenia wymaga zaprzestania komunikacji WE WSZYSTKICH KANALACH
 * natychmiast. Gdyby sprzeciw z WhatsAppa ladowal tylko w bazie wacrm, ta
 * sama osoba dalej dostalaby fale SMS i dalej siedzialaby w Meta Custom
 * Audience. Obowiazek jest miedzykanalowy, wiec lista musi byc jedna.
 *
 * UWAGA NA ARCHITEKTURE WEBHOOKA: route.ts oddaje Meta 200 natychmiast
 * i przetwarza w `after()`, ktorego catch polyka kazdy wyjatek. Meta NIE
 * ponowi. Zatem "fail-closed przez rzucenie" tutaj nic nie daje - nie ma
 * komu tego zlapac. Trwalosc sprzeciwu musi zapewnic TEN proces:
 *   1. ponawiamy zapis lokalnie (3 proby, narastajaco),
 *   2. dopiero po wyczerpaniu prob rzucamy, a wolajacy ma obowiazek
 *      zablokowac kontakt lokalnie i zalogowac to glosno.
 * Insert jest idempotentny (UNIQUE phone_e164), wiec ponowienia sa
 * bezpieczne.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Powody dozwolone przez suppression_list_reason_check. */
export type SuppressionReason =
  'stop' | 'odmowa' | 'wycofanie_zgody' | 'zadanie_usuniecia' | 'inne';

let _client: SupabaseClient | null = null;

/**
 * Klient bazy kalkulatora. Osobne zmienne srodowiskowe, celowo nie
 * wspoldzielone z NEXT_PUBLIC_SUPABASE_URL - to inny projekt i inny
 * service role key.
 */
function suppressionDb(): SupabaseClient | null {
  const url = process.env.SUPPRESSION_SUPABASE_URL;
  const key = process.env.SUPPRESSION_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  if (!_client) _client = createClient(url, key);
  return _client;
}

/**
 * Numer w formacie, ktorego oczekuje suppression_list: 48XXXXXXXXX,
 * same cyfry, bez plusa. Meta oddaje `from` juz w tej postaci, ale nie
 * ufamy temu na slowo - normalizujemy tak samo jak meta_ca_prepare.py,
 * inaczej ten sam czlowiek trafi do listy dwa razy pod dwoma zapisami
 * i UNIQUE nie zadziala.
 */
export function normalizePlPhone(raw: string): string | null {
  let digits = (raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0048')) digits = digits.slice(4);
  else if (digits.startsWith('48') && digits.length === 11)
    digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 10)
    digits = digits.slice(1);
  if (digits.length === 9) digits = `48${digits}`;
  return digits.length === 11 && digits.startsWith('48') ? digits : null;
}

/** Numer do logu: 48601***663. Log nie ma byc druga kopia bazy. */
export function maskPhone(e164: string): string {
  return e164.length >= 8 ? `${e164.slice(0, 5)}***${e164.slice(-3)}` : '***';
}

/**
 * Tresci, ktore traktujemy jako sprzeciw. Przycisk szablonu
 * reaktywacja_analiza_dachu ma tytul "Nie chce wiadomosci"; SMS-owy
 * odpowiednik to "STOP". Porownanie bez znakow diakrytycznych i bez
 * wielkosci liter, bo klient wpisze co zechce.
 */
const OPT_OUT_PHRASES = [
  'stop',
  'nie chce wiadomosci',
  'nie chce wiadomo',
  'rezygnuje',
  'rezygnacja',
  'wypisz',
  'usun mnie',
];

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l') // ł nie rozklada sie przez NFD
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .trim();
}

/**
 * Czy tresc przychodzaca jest sprzeciwem.
 *
 * Dopasowanie po CALYCH SLOWACH, nie przez `includes`. Naiwne `includes('stop')`
 * lapie "stopien", "stopa", "stopni" - czyli "Jaki stopien nachylenia dachu?"
 * zostaloby uznane za rezygnacje i wyrzucilo zainteresowanego leada z lejka.
 * To dokladnie ten blad, przed ktorym ostrzega komentarz w suppression_list.sql.
 * Po `fold()` tekst jest juz ASCII, wiec \b dziala poprawnie.
 */
const OPT_OUT_PATTERNS = OPT_OUT_PHRASES.map(
  (phrase) =>
    new RegExp(`(^|\\W)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`)
);

export function isOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  const folded = fold(text);
  return OPT_OUT_PATTERNS.some((re) => re.test(folded));
}

/**
 * Zapisuje sprzeciw. Idempotentny: powtorzony numer nie tworzy duplikatu
 * (UNIQUE phone_e164), wiec retry Meta jest bezpieczny.
 *
 * @throws gdy nie da sie zapisac - wolajacy MUSI to potraktowac jako blad.
 */
export async function recordOptOut(params: {
  phone: string;
  channel?: 'whatsapp' | 'sms' | 'telefon' | 'email' | 'formularz';
  reason?: SuppressionReason;
  note?: string;
}): Promise<{ recorded: boolean; phone: string }> {
  const db = suppressionDb();
  if (!db) {
    throw new Error(
      'suppression: brak SUPPRESSION_SUPABASE_URL / SUPPRESSION_SUPABASE_SERVICE_KEY - ' +
        'nie mam gdzie zapisac sprzeciwu, a zignorowanie go jest niedopuszczalne'
    );
  }

  const phone = normalizePlPhone(params.phone);
  if (!phone) {
    throw new Error(
      `suppression: nie umiem znormalizowac numeru ${maskPhone(params.phone)}`
    );
  }

  // 3 proby z narastajaca przerwa. Sprzeciwu nie wolno zgubic przez
  // chwilowy timeout sieci miedzy VPS a projektem kalkulatora.
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await db.from('suppression_list').upsert(
      {
        phone_e164: phone,
        reason: params.reason ?? 'stop',
        channel: params.channel ?? 'whatsapp',
        note: params.note ?? null,
      },
      { onConflict: 'phone_e164', ignoreDuplicates: true }
    );

    if (!error) {
      console.info(
        `[suppression] zapisano sprzeciw ${maskPhone(phone)} (${params.channel ?? 'whatsapp'}, proba ${attempt})`
      );
      return { recorded: true, phone };
    }

    lastError = error.message;
    console.warn(
      `[suppression] proba ${attempt}/3 nieudana dla ${maskPhone(phone)}: ${error.message}`
    );
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
  }

  throw new Error(
    `suppression: zapis nieudany po 3 probach dla ${maskPhone(phone)}: ${lastError}`
  );
}

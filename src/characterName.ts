// FF14 のキャラクター名のルール
// - 使える文字は半角英字（a〜z）と ' （アポストロフィ）と - （ハイフン）だけ
// - 名前・苗字はそれぞれ2〜15文字で、合わせて20文字以内
// - 名前・苗字の先頭は自動で大文字になる
export const MIN_NAME_PART_LENGTH = 2;
export const MAX_NAME_PART_LENGTH = 15;
export const MAX_NAME_TOTAL_LENGTH = 20;
const NAME_PART_PATTERN = /^[a-z'-]+$/i;

export type CharacterNameResult = { ok: true; name: string } | { ok: false; errors: string[] };

/** 全角英字や、スマホで自動変換される ’ を、ゲームと同じ半角文字にそろえる */
const normalizePart = (part: string): string => part.normalize('NFKC').trim().replace(/[‘’]/g, "'");

/** 先頭だけ大文字、残りは小文字にする */
const capitalize = (part: string): string => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();

/** ルールに合っていれば「Firstname Lastname」の形に整えて返し、合わなければ理由を返す */
export const checkCharacterName = (rawFirstName: string, rawLastName: string): CharacterNameResult => {
  const firstName = normalizePart(rawFirstName);
  const lastName = normalizePart(rawLastName);
  const errors: string[] = [];

  for (const [label, part] of [['名前', firstName], ['苗字', lastName]] as const) {
    if (!NAME_PART_PATTERN.test(part)) {
      errors.push(`${label}に使えるのは半角英字（a〜z）と ' - だけです。`);
    }
    if (part.length < MIN_NAME_PART_LENGTH || part.length > MAX_NAME_PART_LENGTH) {
      errors.push(`${label}は${MIN_NAME_PART_LENGTH}〜${MAX_NAME_PART_LENGTH}文字にしてください（今は${part.length}文字）。`);
    }
  }

  const total = firstName.length + lastName.length;
  if (total > MAX_NAME_TOTAL_LENGTH) {
    errors.push(`名前と苗字は合わせて${MAX_NAME_TOTAL_LENGTH}文字以内にしてください（今は${total}文字）。`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, name: `${capitalize(firstName)} ${capitalize(lastName)}` };
};

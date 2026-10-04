/**
 * Display names for anonymous peers.
 *
 * Two lists so two people on the same network rarely collide on a name, which
 * matters because names are the only identifier shown in the nearby list.
 */
const POOL = [
  'Pika', 'Zard', 'Eevee', 'Magi', 'Snorlax', 'Ditto', 'Mew', 'Lucario', 'Goomy', 'Togepi',
  'Greninja', 'Chomp', 'Infernape', 'Bidoof', 'Sylveon', 'Scorbunny', 'Quagsire', 'Zorua',
  'Sableye', 'Piplup', 'Luffy', 'Zoro', 'Goku', 'Vegeta', 'Itachi', 'Kakashi', 'Sasuke',
  'Levi', 'Eren', 'Nami', 'Killua', 'Gon', 'Gojo', 'Tanjiro', 'Nezuko', 'Baki', 'Yugi',
  'Natsu', 'Shoto', 'Lain', 'Homer', 'Lisa', 'Bart', 'Stewie', 'Peter', 'Fry', 'Bender',
] as const;

export function getRandomName(): string {
  return POOL[Math.floor(Math.random() * POOL.length)];
}

/** Slightly fancier variant, used for flights created via a direct connect. */
export function getRandomNameWithSuffix(): string {
  const base = getRandomName();
  return `${base}-${Math.floor(Math.random() * 90 + 10)}`;
}

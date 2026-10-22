export interface DataCenter {
  name: string;
  worlds: string[];
}

// 他地域のDCを使う場合はここに追加する（ボタンは1行4個並ぶ。ワールドは1DCあたり16まで）
export const DATA_CENTERS: DataCenter[] = [
  { name: 'Elemental', worlds: ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Tonberry', 'Typhon'] },
  { name: 'Gaia', worlds: ['Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima'] },
  { name: 'Mana', worlds: ['Anima', 'Asura', 'Chocobo', 'Hades', 'Ixion', 'Masamune', 'Pandaemonium', 'Titan'] },
  { name: 'Meteor', worlds: ['Belias', 'Mandragora', 'Ramuh', 'Shinryu', 'Unicorn', 'Valefor', 'Yojimbo', 'Zeromus'] },
];

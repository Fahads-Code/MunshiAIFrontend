/* ------------------------------------------------------------------ */
/* WhatsApp message helpers                                            */
/* Koi API ya kharcha nahi: wa.me link se chat khulti hai aur message  */
/* pehle se likha hota hai, dukandar sirf "Send" dabata hai.           */
/* ------------------------------------------------------------------ */

// Apni dukan ka naam yahan likh dein, message ke aakhir mein aa jayega.
// Khali rakhein to naam nahi lagega.
const SHOP_NAME: string = "";

type EntryType = "GAVE" | "GOT";

export interface SavedNotice {
  text: string; // "Ali Raza: Rs. 500 udhar diya. Entry save ho gayi."
  whatsappUrl: string;
  hasPhone: boolean;
}

const money = (n: number) =>
  `Rs. ${(Math.round(Math.abs(n) * 100) / 100).toLocaleString("en-US")}`;

// 0300..., +92300..., 0092300..., 300... sab ko 92300... bana deta hai
export function normalizePkPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  if (d.startsWith("00")) d = d.slice(2); // 0092... -> 92...

  if (d.startsWith("92")) {
    // pehle se country code maujood hai
  } else if (d.startsWith("0")) {
    d = "92" + d.slice(1); // 0300... -> 92300...
  } else if (d.length === 10 && d.startsWith("3")) {
    d = "92" + d; // 300... -> 92300...
  }

  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function buildEntryMessage(a: {
  name: string;
  amount: number;
  type: EntryType;
  balanceAfter: number;
}): string {
  const gave = a.type === "GAVE";
  const bal = Math.round(a.balanceAfter * 100) / 100;

  const date = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const balanceLine =
    bal > 0
      ? `🔴 *Aap ka baqaya:* ${money(bal)}`
      : bal < 0
        ? `🟢 *Hum ne aap ko dene hain:* ${money(bal)}`
        : `✅ *Hisaab barabar hai*`;

  return [
    `🧾 *${SHOP_NAME || "Digital Khata"} - Receipt*`,
    `━━━━━━━━━━━━━━`,
    `👤 *Customer:* ${a.name.trim()}`,
    `📅 *Tareekh:* ${date}`,
    ``,
    gave
      ? `📤 *Udhar Diya:* ${money(a.amount)}`
      : `📥 *Vasool Kiya:* ${money(a.amount)}`,
    `━━━━━━━━━━━━━━`,
    balanceLine,
    ``,
    `_Shukriya!_ 🙏`,
  ].join("\n");
}

// Number sahi ho to seedha us ki chat, warna WhatsApp khud contact chunne dega
export function whatsappUrl(phone: string, message: string): string {
  const n = normalizePkPhone(phone);
  const text = encodeURIComponent(message);
  return n ? `https://wa.me/${n}?text=${text}` : `https://wa.me/?text=${text}`;
}

export function openWhatsApp(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// Entry save hone ke baad dikhne wale notice ke liye
export function makeNotice(a: {
  name: string;
  phone: string;
  amount: number;
  type: EntryType;
  balanceAfter: number;
}): SavedNotice {
  const message = buildEntryMessage(a);
  return {
    text: `${a.name}: ${money(a.amount)} ${
      a.type === "GAVE" ? "udhar diya" : "vasool kiya"
    }. Entry save ho gayi.`,
    whatsappUrl: whatsappUrl(a.phone, message),
    hasPhone: normalizePkPhone(a.phone) !== null,
  };
}
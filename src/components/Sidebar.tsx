import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

type NavItem = {
  label: string;
  path: string;
  icon: React.ReactNode;
};

const MAX_SOURCE_MB = 10; // original file limit (it is resized before saving)
const AVATAR_SIZE = 256; // px, final square size
const AVATAR_QUALITY = 0.8; // jpeg quality
const PHOTO_COLLECTION = "profilePhotos"; // doc id = user uid

const getErrorCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;

const friendlyError = (err: unknown): string => {
  const code = getErrorCode(err);
  if (code === "permission-denied") {
    return "Permission nahi mili. Firestore Rules mein profilePhotos allow karein.";
  }
  if (code === "unauthenticated") return "Pehle login karein.";
  if (err instanceof Error && err.message === "image-load-failed") {
    return "Ye image khul nahi saki. Koi aur image chunein.";
  }
  return code ? `Upload fail: ${code}` : "Photo save nahi ho saki. Dobara koshish karein.";
};

// Center-crops the image to a square, resizes it and returns a small JPEG data URL.
const resizeToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;

      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("image-load-failed"));
        return;
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", AVATAR_QUALITY));
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("image-load-failed"));
    };

    img.src = objectUrl;
  });

export default function Sidebar({
  open,
  onClose,
  onLogout,
  userEmail,
  userPhone,
  userPhotoUrl,
  userDisplayName,
  onNavigate,
  onPhotoChange,
}: {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
  userEmail?: string | null;
  userPhone?: string | null;
  userPhotoUrl?: string | null;
  userDisplayName?: string | null;
  onNavigate?: (path: string) => void;
  onPhotoChange?: (url: string) => void;
}) {
  const internalNav = useNavigate();
  const location = useLocation();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPhoto, setSavedPhoto] = useState<string | null>(null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  // Live-load the saved photo from Firestore for the signed-in user.
  // setState only happens inside subscription callbacks.
  useEffect(() => {
    let unsubDoc: (() => void) | undefined;

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      unsubDoc?.();
      unsubDoc = undefined;

      if (!u) {
        setSavedPhoto(null);
        return;
      }

      unsubDoc = onSnapshot(
        doc(db, PHOTO_COLLECTION, u.uid),
        (snap) => {
          const data = snap.data();
          setSavedPhoto(typeof data?.photo === "string" ? data.photo : null);
        },
        (err) => console.error("Photo load error:", getErrorCode(err), err)
      );
    });

    return () => {
      unsubDoc?.();
      unsubAuth();
    };
  }, []);

  // Saved photo wins; otherwise fall back to whatever the parent passes (e.g. Google photo).
  const photo = savedPhoto ?? userPhotoUrl ?? null;

  const items: NavItem[] = [
    {
      label: "Dashboard",
      path: "/dashboard",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none">
          <path d="M3 13h8V3H3v10zM13 21h8V11h-8v10zM13 3v6h8V3h-8zM3 21h8v-6H3v6z" fill="currentColor" />
        </svg>
      ),
    },
    {
      label: "Smart Assistant",
      path: "/assistant",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 14 8 19 6 17 11 21 14 15 15 14 21 10 17 5 19 7 14 3 11 9 10Z" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      ),
    },
    {
      label: "Customers",
      path: "/customers",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none">
          <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z" fill="currentColor" />
        </svg>
      ),
    },
    {
      label: "Transactions",
      path: "/transactions",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      label: "Reports",
      path: "/reports",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none">
          <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 13v6M12 9v10M17 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      label: "Settings",
      path: "/settings",
      icon: (
        <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none">
          <path d="M12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z" fill="currentColor" />
          <path d="M19.4 15a1.7 1.7 0 00.33 1.86l.06.06a1 1 0 01-1.41 1.41l-.06-.06a1.7 1.7 0 00-1.86-.33 1.7 1.7 0 00-1 .87 1.7 1.7 0 01-2.9 0 1.7 1.7 0 00-1-.87 1.7 1.7 0 00-1.86.33l-.06.06A1 1 0 015.9 16.9l.06-.06a1.7 1.7 0 00.33-1.86 1.7 1.7 0 00-.87-1 1.7 1.7 0 010-2.9 1.7 1.7 0 00.87-1 1.7 1.7 0 00-.33-1.86l-.06-.06A1 1 0 017.1 4.6l.06.06a1.7 1.7 0 001.86.33c.34-.17.7-.26 1-.26.3 0 .66.09 1 .26a1.7 1.7 0 001.86-.33l.06-.06A1 1 0 0115.1 4.6l-.06.06a1.7 1.7 0 00-.33 1.86c.17.34.26.7.26 1 0 .3-.09.66-.26 1a1.7 1.7 0 00.33 1.86l.06.06a1 1 0 01-1.41 1.41l-.06-.06a1.7 1.7 0 00-1.86-.33 1.7 1.7 0 00-1 .87 1.7 1.7 0 01-2.9 0 1.7 1.7 0 00-1-.87 1.7 1.7 0 00-1.86.33l-.06.06A1 1 0 014.6 8.9l.06-.06a1.7 1.7 0 00.33-1.86" stroke="currentColor" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
  ];

  const digitsOnly = (s?: string | null) => (s ? s.replace(/\D/g, "") : "");
  const phoneToLocal0 = (s?: string | null) => {
    if (!s) return null;
    const d = digitsOnly(s);
    if (!d) return null;
    if (d.startsWith("92") && d.length > 2) return "0" + d.slice(2);
    if (d.startsWith("0")) return d;
    return "0" + d;
  };

  const displayUser = () => {
    if (userEmail) return userEmail;
    if (userDisplayName) return userDisplayName;
    const p = phoneToLocal0(userPhone);
    if (p) return p;
    return null;
  };

  const avatarInitial = () => {
    if (userDisplayName) return userDisplayName.charAt(0).toUpperCase();
    if (userEmail) return userEmail.charAt(0).toUpperCase();
    const p = phoneToLocal0(userPhone);
    if (p) return p.slice(-4);
    return "M";
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      closeBtnRef.current?.focus();
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  const go = (path: string) => {
    if (onNavigate) onNavigate(path);
    else internalNav(path);
    onClose();
  };

  const triggerFile = () => {
    if (uploading) return;
    fileInputRef.current?.click();
  };

  const savePhoto = async (file: File) => {
    const user = auth.currentUser;
    if (!user) {
      setError("Pehle login karein.");
      return;
    }

    setUploading(true);
    try {
      const dataUrl = await resizeToDataUrl(file);
      await setDoc(doc(db, PHOTO_COLLECTION, user.uid), {
        photo: dataUrl,
        updatedAt: serverTimestamp(),
      });
      // Show it right away (don't wait for the Firestore listener) and tell the parent.
      setSavedPhoto(dataUrl);
      setBrokenSrc(null);
      onPhotoChange?.(dataUrl);
    } catch (err) {
      console.error("Save photo failed:", getErrorCode(err), err);
      setError(friendlyError(err));
    } finally {
      setUploading(false);
    }
  };

  const onFileSelected = (file?: File | null) => {
    if (!file) return;
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("Sirf image select karein.");
      return;
    }
    if (file.size > MAX_SOURCE_MB * 1024 * 1024) {
      setError(`Image ${MAX_SOURCE_MB}MB se choti honi chahiye.`);
      return;
    }

    void savePhoto(file);
  };

  const showImage = !!photo && brokenSrc !== photo;

  return (
    <div className="fixed inset-0 z-50 flex" aria-hidden={!open}>
      <div onClick={onClose} className="fixed inset-0 bg-black/40 backdrop-blur-sm" aria-hidden="true" />

      <aside
        className="relative w-80 max-w-full bg-white border-r border-slate-100 shadow-2xl transform transition-transform duration-200 ease-out flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
      >
        <div className="px-5 py-4 flex items-center gap-3 border-b border-slate-100">
          <img src="/favicon.png" alt="Munshi AI" className="w-10 h-10 rounded-lg shadow-sm" />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-slate-900 leading-tight">Munshi AI</h4>
            <p className="text-xs text-slate-500">Digital Khata</p>
          </div>
          <button ref={closeBtnRef} onClick={onClose} aria-label="Close menu" className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1">
            ×
          </button>
        </div>

        <div className="px-4 py-4 border-b border-slate-100 flex items-start gap-3">
          <div>
            <div className="relative">
              {showImage ? (
                <img
                  src={photo ?? undefined}
                  alt="User avatar"
                  referrerPolicy="no-referrer"
                  className="w-14 h-14 rounded-full object-cover ring-2 ring-emerald-50 shadow-sm cursor-pointer"
                  onClick={triggerFile}
                  onError={() => setBrokenSrc(photo)}
                />
              ) : (
                <button
                  onClick={triggerFile}
                  aria-label="Change photo"
                  className="w-14 h-14 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-semibold text-sm shadow-sm cursor-pointer"
                >
                  <span className="select-none">{avatarInitial()}</span>
                </button>
              )}

              {uploading && (
                <div className="absolute inset-0 rounded-full bg-white/70 flex items-center justify-center">
                  <div className="w-5 h-5 rounded-full border-2 border-emerald-600 border-t-transparent animate-spin" />
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-500">Signed in as</p>
            <p className="text-sm font-medium text-slate-900 truncate">{displayUser() ?? "No email / No phone"}</p>
            {userEmail && userPhone && <p className="text-xs text-slate-400 truncate">{phoneToLocal0(userPhone)}</p>}
            <button onClick={triggerFile} disabled={uploading} className="mt-1 text-xs text-emerald-700 hover:underline disabled:opacity-50">
              {uploading ? "Saving..." : "Change photo"}
            </button>
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                onFileSelected(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
        </div>

        <nav className="p-3 flex-1 overflow-auto">
          <ul className="space-y-1">
            {items.map((it) => {
              const active = location.pathname === it.path;
              return (
                <li key={it.path}>
                  <button
                    onClick={() => go(it.path)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-xl transition ${
                      active ? "bg-emerald-50 text-emerald-700 font-semibold" : "text-slate-700 hover:bg-slate-50"
                    }`}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="shrink-0">{it.icon}</span>
                    <span className="truncate">{it.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="px-4 py-4 border-t border-slate-100">
          <button
            onClick={() => {
              onLogout();
              onClose();
            }}
            className="w-full h-10 px-3 rounded-xl bg-red-50 text-red-700 font-semibold hover:bg-red-100 transition"
          >
            Logout
          </button>
        </div>
      </aside>
    </div>
  );
}
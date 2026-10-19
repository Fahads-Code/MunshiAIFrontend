import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  GoogleAuthProvider,
  RecaptchaVerifier,
  onAuthStateChanged,
  signInWithPhoneNumber,
  signInWithPopup,
  signInWithRedirect,
} from "firebase/auth";
import type { ConfirmationResult } from "firebase/auth";
import { auth } from "../firebase";

export default function KhataLogin() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendTimer, setResendTimer] = useState(30);
  const [canResend, setCanResend] = useState<boolean>(false);

  // Firebase Confirmation Object & reCAPTCHA ref
  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmationResult | null>(null);
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Pehle se login ho (ya Google redirect se wapas aaye) to seedha Home par
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) navigate("/home", { replace: true });
    });
    return () => unsub();
  }, [navigate]);

  // Timer logic for Resend OTP
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    if (step === "otp" && resendTimer > 0) {
      timer = setInterval(() => {
        setResendTimer((prev) => {
          if (prev <= 1) {
            setCanResend(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => clearInterval(timer);
  }, [step, resendTimer]);

  // Google se login
  const handleGoogleLogin = async () => {
    setError("");
    setGoogleLoading(true);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
      navigate("/home");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (
        code === "auth/popup-blocked" ||
        code === "auth/operation-not-supported-in-this-environment"
      ) {
        // Popup na chale (mobile ya install shuda app) to redirect se login
        try {
          await signInWithRedirect(auth, provider);
          return;
        } catch (redirectErr) {
          console.error("Google redirect error:", redirectErr);
        }
      } else if (
        code === "auth/popup-closed-by-user" ||
        code === "auth/cancelled-popup-request"
      ) {
        // User ne khud band kar diya, koi error nahi dikhana
        setGoogleLoading(false);
        return;
      } else if (code === "auth/network-request-failed") {
        setError("Internet nahi hai. Net chalu kar ke dobara koshish karein.");
        setGoogleLoading(false);
        return;
      } else if (code === "auth/unauthorized-domain") {
        setError(
          "Yeh website Firebase mein authorized nahi hai. Authorized domains mein add karein.",
        );
        setGoogleLoading(false);
        return;
      } else {
        console.error("Google login error:", err);
      }
      setError("Google se login nahi ho saka. Dobara koshish karein.");
    } finally {
      setGoogleLoading(false);
    }
  };

  // Setup Firebase reCAPTCHA
  const setupRecaptcha = () => {
    if (!recaptchaVerifierRef.current) {
      recaptchaVerifierRef.current = new RecaptchaVerifier(
        auth,
        "recaptcha-container",
        {
          size: "invisible",
          callback: () => {
            // reCAPTCHA solved successfully
          },
          "expired-callback": () => {
            setError("reCAPTCHA expire ho gaya. Dobara koshish karein.");
          },
        },
      );
    }
  };

  // Handle Real Firebase Phone Submit & Send OTP
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!phoneNumber || phoneNumber.length < 10) {
      setError("Barah-e-karam sahi mobile number darj karein.");
      return;
    }

    setLoading(true);

    try {
      setupRecaptcha();
      const formattedPhone = `+92${phoneNumber.replace(/\D/g, "")}`;

      const verifier = recaptchaVerifierRef.current;
      if (!verifier) throw new Error("reCAPTCHA initialize nahi ho saka.");

      const confirmation = await signInWithPhoneNumber(
        auth,
        formattedPhone,
        verifier,
      );

      setConfirmationResult(confirmation);
      setStep("otp");
      setResendTimer(30);
      setCanResend(false);
    } catch (err: unknown) {
      console.error(err);
      const errorMessage =
        err instanceof Error
          ? err.message
          : "OTP bhejne mein masla hua. Number check karein.";
      setError(errorMessage);
      if (recaptchaVerifierRef.current) {
        recaptchaVerifierRef.current.clear();
        recaptchaVerifierRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle OTP Input Change & Focus Switching
  const handleOtpChange = (value: string, index: number) => {
    if (value && !/^\d+$/.test(value)) return;

    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number,
  ) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  // Handle OTP Paste
  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").trim();
    if (/^\d{6}$/.test(pastedData)) {
      const digits = pastedData.split("");
      setOtp(digits);
      inputRefs.current[5]?.focus();
    }
  };

  // Handle Real Firebase OTP Verification
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const enteredOtp = otp.join("");

    if (enteredOtp.length < 6) {
      setError("Mukammal 6 digits ka verification code enter karein.");
      return;
    }

    if (!confirmationResult) {
      setError("Session expire ho gaya hai. Dobara OTP mangwayein.");
      return;
    }

    setLoading(true);

    try {
      await confirmationResult.confirm(enteredOtp);
      navigate("/home");
    } catch (err: unknown) {
      console.error(err);
      setError("Wrong OTP. Check Again");
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP
  const handleResend = async () => {
    if (!canResend) return;
    setOtp(["", "", "", "", "", ""]);
    setError("");

    const syntheticEvent = { preventDefault: () => {} } as React.FormEvent;
    await handleSendOtp(syntheticEvent);
  };

  return (
    <div className="min-h-dvh h-dvh overflow-y-auto sm:overflow-y-hidden bg-slate-50 flex flex-col justify-between items-center px-4 py-3 sm:p-6 font-sans text-slate-800">
      <div id="recaptcha-container"></div>

      <div className="w-full max-w-md pt-2 sm:pt-6 text-center shrink-0">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-xl overflow-hidden">
          <img
            src="/favicon.png"
            alt="Munshi AI Logo"
            className="w-full h-full object-contain"
          />
        </div>

        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
          Munshi AI
        </h1>

        <p className="text-slate-500 text-sm mt-1 font-medium">
          Easy and secure digital Munshi AI
        </p>
      </div>

      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl shadow-slate-200/60 border border-slate-100 p-6 sm:p-8 my-auto transition-all">
        {error && (
          <div className="mb-6 p-3.5 bg-red-50 border border-red-100 text-red-600 text-xs sm:text-sm rounded-xl flex items-center gap-2">
            <svg
              className="w-4 h-4 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {step === "phone" ? (
          <div className="space-y-6">
            {/* Google login */}
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={googleLoading || loading}
              className="w-full bg-white hover:bg-slate-50 active:scale-[0.99] text-slate-700 font-semibold py-3.5 rounded-2xl border border-slate-200 shadow-sm transition-all duration-200 flex items-center justify-center gap-3 disabled:opacity-60 disabled:pointer-events-none"
            >
              <GoogleIcon className="w-5 h-5" />
              <span>
                {googleLoading ? "Logging in..." : "Login with Google"}
              </span>
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs text-slate-400 font-medium">
                Login with Phone Number
              </span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            <form onSubmit={handleSendOtp} className="space-y-6">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                  Mobile Number
                </label>
                <div className="flex items-center rounded-2xl border border-slate-200 bg-slate-50/50 focus-within:border-emerald-500 focus-within:bg-white focus-within:ring-4 focus-within:ring-emerald-500/10 transition-all overflow-hidden">
                  <span className="pl-4 pr-2 text-slate-600 font-semibold text-sm select-none border-r border-slate-200 py-3.5 flex items-center gap-1.5">
                    +92
                  </span>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) =>
                      setPhoneNumber(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder="300 1234567"
                    maxLength={10}
                    className="w-full bg-transparent px-3 py-3.5 text-slate-900 font-medium placeholder-slate-400 focus:outline-none text-base"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || googleLoading}
                className="w-full bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-semibold py-3.5 rounded-2xl shadow-lg shadow-emerald-600/20 transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60 disabled:pointer-events-none"
              >
                {loading ? (
                  <>
                    <Spinner />
                    <span>Sending OTP...</span>
                  </>
                ) : (
                  "Send OTP Code"
                )}
              </button>
            </form>
          </div>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-6">
            <div className="text-center space-y-1">
              <p className="text-sm text-slate-500">
                6-digits sent to this number:
              </p>
              <div className="flex items-center justify-center gap-2">
                <span className="font-bold text-slate-800 text-base">
                  +92 {phoneNumber}
                </span>
                <button
                  type="button"
                  onClick={() => setStep("phone")}
                  className="text-xs font-semibold text-emerald-600 hover:underline"
                >
                  Change Number
                </button>
              </div>
            </div>

            <div className="flex justify-between gap-1.5 sm:gap-2">
              {otp.map((digit, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    inputRefs.current[index] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleOtpChange(e.target.value, index)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                  onPaste={handleOtpPaste}
                  className="w-11 h-12 sm:w-12 sm:h-14 text-center text-lg sm:text-xl font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 outline-none transition-all"
                />
              ))}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-semibold py-3.5 rounded-2xl shadow-lg shadow-emerald-600/20 transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-60 disabled:pointer-events-none"
            >
              {loading ? (
                <>
                  <Spinner />
                  <span>Verifying...</span>
                </>
              ) : (
                "Log In to Your Account"
              )}
            </button>

            <div className="text-center pt-2">
              {canResend ? (
                <button
                  type="button"
                  onClick={handleResend}
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 transition"
                >
                  Code Not Received? Send Again
                </button>
              ) : (
                <p className="text-xs text-slate-400">
                  Wait to send code again:{" "}
                  <span className="font-semibold text-slate-600">
                    {resendTimer}s
                  </span>
                </p>
              )}
            </div>
          </form>
        )}
      </div>

      <div className="w-full max-w-md text-center text-xs text-slate-400 pb-2">
        <p>© {new Date().getFullYear()} Khata App. All things are secure.</p>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-5 w-5 text-white"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function GoogleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
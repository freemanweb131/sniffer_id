"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, Download, Loader2, ImageIcon, AlertTriangle, Wand2, X } from "lucide-react";
import type { CardFormData, GenerateResponse } from "@/lib/types";

const FREE_TRIAL_KEY = "sniffer_id_guest_used";

function getInitialGuestUsed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(FREE_TRIAL_KEY) === "true";
}

const initialFields: CardFormData = {
  name: "",
  dob: "",
  iss: "",
  exp: "",
  address: "",
};

export default function IdEditorForm() {
  const [image, setImage] = useState<string | null>(null);
  const [fields, setFields] = useState<CardFormData>(initialFields);
  const [enhanceClarity, setEnhanceClarity] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guestUsed, setGuestUsed] = useState<boolean>(getInitialGuestUsed);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((file: File | null) => {
    setError(null);
    setResultImage(null);

    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Only JPEG, PNG, and WEBP images are allowed.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("Image must be under 10MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0] ?? null;
      handleFileChange(file);
    },
    [handleFileChange]
  );

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      handleFileChange(file);
    },
    [handleFileChange]
  );

  const handleFieldChange = (key: keyof CardFormData, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResultImage(null);

    if (!image) {
      setError("Please upload an image first.");
      return;
    }

    if (guestUsed) {
      setError("Guest trial already used. Please sign in to continue.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, fields, enhanceClarity }),
      });

      const data: GenerateResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Request failed with status ${response.status}`);
      }

      setResultImage(data.image ?? null);
      if (!guestUsed) {
        setGuestUsed(true);
        localStorage.setItem(FREE_TRIAL_KEY, "true");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!resultImage) return;

    try {
      const response = await fetch(resultImage);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "edited-id-card.png";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch {
      window.open(resultImage, "_blank");
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          ID Card Mockup Editor
        </h1>
        <p className="mt-2 text-slate-600">
          Generate design mockups and authorized test IDs from a template image.
        </p>
      </div>

      {guestUsed && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="text-sm">
              Guest trial used. In a production app, sign-in would be required for additional
              generations.
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-10 text-center transition-colors hover:border-indigo-500 hover:bg-indigo-50"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={onFileInputChange}
            />
            {image ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image}
                  alt="Uploaded ID template"
                  className="max-h-64 rounded-lg object-contain shadow-sm"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setImage(null);
                    setResultImage(null);
                  }}
                  className="absolute -right-3 -top-3 rounded-full bg-white p-1 shadow hover:bg-slate-100"
                >
                  <X className="h-4 w-4 text-slate-600" />
                </button>
              </div>
            ) : (
              <>
                <div className="mb-4 rounded-full bg-white p-4 shadow-sm">
                  <Upload className="h-8 w-8 text-indigo-600" />
                </div>
                <p className="text-lg font-medium text-slate-900">
                  Drop an image here, or click to upload
                </p>
                <p className="mt-1 text-sm text-slate-500">JPEG, PNG, or WEBP up to 10MB</p>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-900">
              <ImageIcon className="h-5 w-5 text-indigo-600" />
              Card Details
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  { key: "name", label: "Full Name" },
                  { key: "dob", label: "Date of Birth" },
                  { key: "iss", label: "Issue Date" },
                  { key: "exp", label: "Expiration Date" },
                ] as const
              ).map(({ key, label }) => (
                <div key={key} className="space-y-1">
                  <label htmlFor={key} className="block text-sm font-medium text-slate-700">
                    {label}
                  </label>
                  <input
                    id={key}
                    type="text"
                    value={fields[key]}
                    onChange={(e) => handleFieldChange(key, e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder={label}
                    required
                  />
                </div>
              ))}
              <div className="space-y-1 sm:col-span-2">
                <label htmlFor="address" className="block text-sm font-medium text-slate-700">
                  Address
                </label>
                <input
                  id="address"
                  type="text"
                  value={fields.address}
                  onChange={(e) => handleFieldChange("address", e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="Street address"
                  required
                />
              </div>
            </div>

            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={enhanceClarity}
                onClick={() => setEnhanceClarity((prev) => !prev)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                  enhanceClarity ? "bg-indigo-600" : "bg-slate-200"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    enhanceClarity ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
              <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <Wand2 className="h-4 w-4" />
                Enhance clarity
              </span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !image || guestUsed}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Wand2 className="h-5 w-5" />
                Generate Mockup
              </>
            )}
          </button>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Result</h2>
          {resultImage ? (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-slate-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resultImage}
                  alt="Generated ID card"
                  className="w-full object-contain"
                />
              </div>
              <button
                type="button"
                onClick={handleDownload}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                <Download className="h-4 w-4" />
                Download
              </button>
            </div>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-slate-400">
              <ImageIcon className="mb-2 h-10 w-10" />
              <p className="text-sm">Result will appear here</p>
            </div>
          )}
        </div>
      </form>

      <footer className="mt-12 border-t border-slate-200 pt-6 text-center">
        <p className="flex items-start justify-center gap-2 text-sm text-slate-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          For design mockups, prototypes, and authorized testing only. Do not use to alter genuine
          identification documents.
        </p>
      </footer>
    </div>
  );
}

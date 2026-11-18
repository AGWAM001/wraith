/**
 * What the chain says about a member's two addresses.
 *
 * Every function here answers one question and returns `null` when the
 * question could not be answered. `null` is never "no": the caller keeps a
 * role it cannot re-check rather than taking it away because an RPC node was
 * slow. Only a definite answer changes anything.
 *
 * Reads go straight to Soroban RPC and Horizon rather than to the indexer's
 * tables. Twenty tokens, a signer list and a counter are a handful of reads,
 * and they stay correct whether or not the indexer is watching the contract.
 */

import {
  Account,
  Address,
  Contract,
  Networks,
  rpc as RPC,
  scValToNative,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { getRpc } from "../rpc";
import {
  discordNetwork,
  discordRpcUrl,
  horizonUrl,
  namesContractId,
  veiliansContractId,
  walletWasmHashes,
} from "./config";

const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HORIZON_TIMEOUT_MS = 10_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Veil-ians is a fixed collection of twenty. */
const VEILIANS_COLLECTION_SIZE = 20;
/** `NameState::Active` in the registry contract. */
const NAME_STATE_ACTIVE = 0;

let ownClient: { url: string; server: RPC.Server } | null = null;

function rpc(): RPC.Server {
  const url = discordRpcUrl();
  if (!url) return getRpc(discordNetwork());
  if (!ownClient || ownClient.url !== url) {
    ownClient = { url, server: new RPC.Server(url, { allowHttp: url.startsWith("http://") }) };
  }
  return ownClient.server;
}

function passphrase(): string {
  return discordNetwork() === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/** Call a read-only contract function. Throws when the simulation fails. */
async function simulateRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase(),
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(0)
    .build();
  const response = await rpc().simulateTransaction(tx);
  if (RPC.Api.isSimulationSuccess(response) && response.result) {
    return scValToNative(response.result.retval);
  }
  throw new Error(`simulation of ${method} failed`);
}

async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export function isContractAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}

export function isAccountAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

/**
 * Whether this contract runs Veil's wallet code.
 *
 * Compared by code hash, which is exact: a contract that merely behaves like a
 * Veil wallet has a different hash. `false` covers "no such contract" too.
 */
export async function isVeilWallet(wallet: string): Promise<boolean | null> {
  return attempt(async () => {
    const result = await rpc().getLedgerEntries(new Contract(wallet).getFootprint());
    const entry = result.entries[0];
    if (!entry) return false;
    const executable = entry.val.contractData().val().instance().executable();
    if (executable.switch().name !== "contractExecutableWasm") return false;
    return walletWasmHashes().includes(Buffer.from(executable.wasmHash()).toString("hex"));
  });
}

/** The wallet's passkey public keys, each 65 bytes, as lower-case hex. */
export async function walletSigners(wallet: string): Promise<string[] | null> {
  return attempt(async () => {
    const native = await simulateRead(wallet, "get_signers");
    const values = native instanceof Map ? [...native.values()] : Object.values(native as object);
    return values
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => Buffer.from(value).toString("hex"));
  });
}

/** The wallet's nonce: how many passkey-signed actions it has ever made. */
export async function walletNonce(wallet: string): Promise<number | null> {
  return attempt(async () => {
    const nonce = Number(await simulateRead(wallet, "get_nonce"));
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("unreadable nonce");
    return nonce;
  });
}

/** Whether any of these addresses holds a Veil-ian. */
export async function holdsVeilian(addresses: readonly string[]): Promise<boolean | null> {
  if (addresses.length === 0) return false;
  const mine = new Set(addresses);
  const contractId = veiliansContractId();
  return attempt(async () => {
    const sold = await simulateRead(contractId, "sold");
    if (!Array.isArray(sold)) throw new Error("unreadable sold list");
    const ids = sold
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= VEILIANS_COLLECTION_SIZE);
    for (const id of ids) {
      const owner = await simulateRead(contractId, "owner_of", [nativeToScVal(id, { type: "u32" })]);
      if (typeof owner === "string" && mine.has(owner)) return true;
    }
    return false;
  });
}

/**
 * Which of these candidate names are active and point at one of the member's
 * addresses. The registry cannot list a holder's names, so the app sends the
 * names it knows about and each one is put to the registry here.
 */
export async function activeNames(
  candidates: readonly string[],
  addresses: readonly string[],
): Promise<string[] | null> {
  const mine = new Set(addresses);
  const contractId = namesContractId();
  return attempt(async () => {
    const kept: string[] = [];
    for (const name of candidates) {
      const arg = nativeToScVal(name, { type: "string" });
      const [target, state] = await Promise.all([
        simulateRead(contractId, "resolve", [arg]),
        simulateRead(contractId, "state", [arg]),
      ]);
      if (typeof target === "string" && mine.has(target) && Number(state) === NAME_STATE_ACTIVE) {
        kept.push(name);
      }
    }
    return kept;
  });
}

/**
 * Whether any of these addresses owns a name token at all.
 *
 * The fallback when no candidate names are known. Coarser than
 * {@link activeNames}: a name that has run out still counts here until
 * somebody else registers it.
 */
export async function ownsAnyName(addresses: readonly string[]): Promise<boolean | null> {
  if (addresses.length === 0) return false;
  const contractId = namesContractId();
  return attempt(async () => {
    for (const address of addresses) {
      const balance = await simulateRead(contractId, "balance", [new Address(address).toScVal()]);
      if (Number(balance) > 0) return true;
    }
    return false;
  });
}

interface HorizonOperation {
  created_at?: string;
}

async function horizonOperations(account: string, order: "asc" | "desc", limit: number): Promise<HorizonOperation[] | "missing"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);
  try {
    const url = `${horizonUrl()}/accounts/${account}/operations?order=${order}&limit=${limit}`;
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`horizon ${response.status}`);
    const body = (await response.json()) as { _embedded?: { records?: unknown } };
    const records = body?._embedded?.records;
    return Array.isArray(records) ? (records as HorizonOperation[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many operations the spending account made in the last thirty days,
 * counted up to 200. The spending account is the source of every transaction
 * a Veil wallet sends, so this is the wallet's activity too.
 */
export async function recentOperationCount(account: string, now = Date.now()): Promise<number | null> {
  return attempt(async () => {
    const records = await horizonOperations(account, "desc", 200);
    if (records === "missing") return 0;
    const since = now - THIRTY_DAYS_MS;
    return records.filter((record) => {
      const at = Date.parse(record.created_at ?? "");
      return Number.isFinite(at) && at >= since;
    }).length;
  });
}

/** When the spending account first did anything. Null when unknown or unused. */
export async function firstOperationAt(account: string): Promise<Date | null> {
  const records = await attempt(() => horizonOperations(account, "asc", 1));
  if (!records || records === "missing" || records.length === 0) return null;
  const at = Date.parse(records[0].created_at ?? "");
  return Number.isFinite(at) ? new Date(at) : null;
}

import { readFileSync } from "fs";
import path from "path";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { GraphQLError } from "graphql";

type AllowList = Record<string, string>;

let allowList: AllowList | null = null;

function allowListPath(): string {
  return path.resolve(
    process.env.PERSISTED_QUERIES_PATH ?? path.join(process.cwd(), "persisted-queries.json")
  );
}

function loadAllowList(): AllowList {
  if (allowList !== null) {
    return allowList;
  }

  try {
    allowList = JSON.parse(readFileSync(allowListPath(), "utf8")) as AllowList;
  } catch {
    allowList = {};
  }

  return allowList;
}

export function getPersistedQuery(hash: string): string | undefined {
  return loadAllowList()[hash];
}

export function resetPersistedQueryCache(): void {
  allowList = null;
}

/**
 * A production refusal as a client error (#404).
 *
 * The refusal is thrown from the request listener's didResolveOperation,
 * not from requestDidStart: Apollo Server treats an error thrown by
 * requestDidStart itself as a server fault — HTTP 500 with the message
 * masked as "Internal server error" — while an error thrown from
 * didResolveOperation reaches the client as-is, and extensions.http sets
 * the response status. didResolveOperation runs before any resolver, so a
 * refused request still does no resolver work.
 */
function refusal(message: string, code: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code, http: { status: 400 } } });
}

export const persistedQueryPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart(requestContext) {
    const { request } = requestContext;
    const hash = request?.extensions?.persistedQuery?.sha256Hash;
    const production = process.env.NODE_ENV === "production";

    if (!hash) {
      if (!production) {
        return;
      }

      return {
        async didResolveOperation() {
          throw refusal("Persisted query hash is required in production", "PERSISTED_QUERY_REQUIRED");
        },
      };
    }

    const query = getPersistedQuery(hash);
    if (query) {
      request.query = query;
      delete request.extensions?.persistedQuery;
      return;
    }

    if (!production) {
      return;
    }

    // Unknown hash in production. Keep Apollo's built-in persisted-query
    // handling from answering first — with support disabled it would reply
    // "PersistedQueryNotSupported" with a 200 — by dropping the extension,
    // and stand in a query that parses when the client sent none, purely so
    // the pipeline reaches didResolveOperation; the refusal throws there
    // before anything executes, so the stand-in never runs.
    delete request.extensions?.persistedQuery;
    if (!request.query) {
      request.query = "{ __typename }";
    }

    return {
      async didResolveOperation() {
        throw refusal(`Persisted query not found for hash ${hash}`, "PERSISTED_QUERY_NOT_FOUND");
      },
    };
  },
};

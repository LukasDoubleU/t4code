import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";
import * as SourceControlSignIn from "./SourceControlSignIn.ts";

const github = SourceControlProviderKind.make("github");

const starWith = (serverVersion: string) =>
  Effect.gen(function* () {
    const starred: string[] = [];
    const driver = {
      driver: { kind: github },
      instance: {
        starRepository: (_host: string, repository: string) =>
          Effect.sync(() => {
            starred.push(repository);
            return true;
          }),
      },
    } as unknown as SourceControlBuiltInDrivers.SourceControlDriverEntry;
    const signIn = yield* SourceControlSignIn.make(serverVersion).pipe(
      Effect.provideService(SourceControlBuiltInDrivers.SourceControlDrivers, [driver]),
    );
    const result = yield* signIn.star({
      provider: github,
      host: "github.com",
      repository: "pingdotgg/t3code",
    });
    return { result, starred };
  });

it.effect("stars only on builds that are not the fork's", () =>
  Effect.gen(function* () {
    for (const version of ["0.1.8-t4.1", "0.1.8-test.2"]) {
      assert.deepStrictEqual(yield* starWith(version), { result: false, starred: [] });
    }
    assert.deepStrictEqual(yield* starWith("0.1.7"), {
      result: true,
      starred: ["pingdotgg/t3code"],
    });
  }),
);

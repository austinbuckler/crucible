/**
 * @generated SignedSource<<56cb532c0bc5a8151a36d3ed43e7c9c9>>
 * @relayHash 4747bacbb3c22086f1d3638cbde7290c
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

// @relayRequestID 4747bacbb3c22086f1d3638cbde7290c

import type { ConcreteRequest } from 'relay-runtime';
import type { LiveState, FragmentRefs } from "relay-runtime";
import type { storage as crucibleAppStorageResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleAppStorageResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleAppStorageResolverType satisfies (
  __relay_model_instance: CrucibleApp____relay_model_instance$data['__relay_model_instance'],
) => CrucibleStorage | null | undefined);
import type { sync as crucibleAppSyncResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleAppSyncResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleAppSyncResolverType satisfies (
  __relay_model_instance: CrucibleApp____relay_model_instance$data['__relay_model_instance'],
) => CrucibleSync | null | undefined);
import type { persisted as crucibleStoragePersistedResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleStoragePersistedResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleStoragePersistedResolverType satisfies (
  __relay_model_instance: CrucibleStorage____relay_model_instance$data['__relay_model_instance'],
) => LiveState<boolean | null | undefined>);
import type { quota as crucibleStorageQuotaResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleStorageQuotaResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleStorageQuotaResolverType satisfies (
  __relay_model_instance: CrucibleStorage____relay_model_instance$data['__relay_model_instance'],
) => LiveState<number | null | undefined>);
import type { usageRatio as crucibleStorageUsageRatioResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleStorageUsageRatioResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleStorageUsageRatioResolverType satisfies (
  __relay_model_instance: CrucibleStorage____relay_model_instance$data['__relay_model_instance'],
) => LiveState<number | null | undefined>);
import type { usage as crucibleStorageUsageResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleStorageUsageResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleStorageUsageResolverType satisfies (
  __relay_model_instance: CrucibleStorage____relay_model_instance$data['__relay_model_instance'],
) => LiveState<number | null | undefined>);
import type { online as crucibleSyncOnlineResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleSyncOnlineResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleSyncOnlineResolverType satisfies (
  __relay_model_instance: CrucibleSync____relay_model_instance$data['__relay_model_instance'],
) => LiveState<boolean | null | undefined>);
import type { pendingMutations as crucibleSyncPendingMutationsResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleSyncPendingMutationsResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleSyncPendingMutationsResolverType satisfies (
  __relay_model_instance: CrucibleSync____relay_model_instance$data['__relay_model_instance'],
) => LiveState<number | null | undefined>);
import type { status as crucibleSyncStatusResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `crucibleSyncStatusResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(crucibleSyncStatusResolverType satisfies (
  __relay_model_instance: CrucibleSync____relay_model_instance$data['__relay_model_instance'],
) => LiveState<string | null | undefined>);
import type { app as queryAppResolverType } from "../../__crucible__/app-resolvers";
// Type assertion validating that `queryAppResolverType` resolver is correctly implemented.
// A type error here indicates that the type signature of the resolver module is incorrect.
(queryAppResolverType satisfies () => CrucibleApp | null | undefined);
import type { CrucibleApp } from "../../__crucible__/app-resolvers";
import type { CrucibleStorage } from "../../__crucible__/app-resolvers";
import type { CrucibleSync } from "../../__crucible__/app-resolvers";
export type page_TodosQuery$variables = Record<PropertyKey, never>;
export type page_TodosQuery$data = {
  readonly app: {
    readonly storage: {
      readonly persisted: boolean | null | undefined;
      readonly quota: number | null | undefined;
      readonly usage: number | null | undefined;
      readonly usageRatio: number | null | undefined;
    } | null | undefined;
    readonly sync: {
      readonly online: boolean | null | undefined;
      readonly pendingMutations: number | null | undefined;
      readonly status: string | null | undefined;
    } | null | undefined;
  } | null | undefined;
  readonly todos: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly completed: boolean;
        readonly databaseId: string;
        readonly id: string;
        readonly title: string;
        readonly updatedAt: string;
      } | null | undefined;
    }>;
  };
};
export type page_TodosQuery = {
  response: page_TodosQuery$data;
  variables: page_TodosQuery$variables;
};

import {app as queryAppResolver} from '../../__crucible__/app-resolvers';
import {online as crucibleSyncOnlineResolver} from '../../__crucible__/app-resolvers';
import {pendingMutations as crucibleSyncPendingMutationsResolver} from '../../__crucible__/app-resolvers';
import {persisted as crucibleStoragePersistedResolver} from '../../__crucible__/app-resolvers';
import {quota as crucibleStorageQuotaResolver} from '../../__crucible__/app-resolvers';
import {status as crucibleSyncStatusResolver} from '../../__crucible__/app-resolvers';
import {storage as crucibleAppStorageResolver} from '../../__crucible__/app-resolvers';
import {sync as crucibleAppSyncResolver} from '../../__crucible__/app-resolvers';
import {usage as crucibleStorageUsageResolver} from '../../__crucible__/app-resolvers';
import {usageRatio as crucibleStorageUsageRatioResolver} from '../../__crucible__/app-resolvers';
import CrucibleApp____relay_model_instance_graphql from './../../__crucible__/__generated__/CrucibleApp____relay_model_instance.graphql';
import CrucibleStorage____relay_model_instance_graphql from './../../__crucible__/__generated__/CrucibleStorage____relay_model_instance.graphql';
import CrucibleSync____relay_model_instance_graphql from './../../__crucible__/__generated__/CrucibleSync____relay_model_instance.graphql';
import {resolverDataInjector} from 'relay-runtime/experimental';

const node: ConcreteRequest = (function(){
var v0 = {
  "args": null,
  "kind": "FragmentSpread",
  "name": "CrucibleApp____relay_model_instance"
},
v1 = {
  "args": null,
  "kind": "FragmentSpread",
  "name": "CrucibleStorage____relay_model_instance"
},
v2 = {
  "args": null,
  "kind": "FragmentSpread",
  "name": "CrucibleSync____relay_model_instance"
},
v3 = {
  "alias": null,
  "args": [
    {
      "kind": "Literal",
      "name": "first",
      "value": 50
    }
  ],
  "concreteType": "TodoConnection",
  "kind": "LinkedField",
  "name": "todos",
  "plural": false,
  "selections": [
    {
      "alias": null,
      "args": null,
      "concreteType": "TodoEdge",
      "kind": "LinkedField",
      "name": "edges",
      "plural": true,
      "selections": [
        {
          "alias": null,
          "args": null,
          "concreteType": "Todo",
          "kind": "LinkedField",
          "name": "node",
          "plural": false,
          "selections": [
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "id",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "databaseId",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "title",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "completed",
              "storageKey": null
            },
            {
              "alias": null,
              "args": null,
              "kind": "ScalarField",
              "name": "updatedAt",
              "storageKey": null
            }
          ],
          "storageKey": null
        }
      ],
      "storageKey": null
    }
  ],
  "storageKey": "todos(first:50)"
},
v4 = [
  {
    "alias": null,
    "args": null,
    "kind": "ScalarField",
    "name": "__relay_model_instance",
    "storageKey": null
  }
],
v5 = {
  "kind": "InlineFragment",
  "selections": (v4/*:: as any*/),
  "type": "CrucibleApp",
  "abstractKey": null
},
v6 = {
  "kind": "InlineFragment",
  "selections": (v4/*:: as any*/),
  "type": "CrucibleStorage",
  "abstractKey": null
},
v7 = {
  "kind": "InlineFragment",
  "selections": (v4/*:: as any*/),
  "type": "CrucibleSync",
  "abstractKey": null
};
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": {
      "hasClientEdges": true
    },
    "name": "page_TodosQuery",
    "selections": [
      {
        "kind": "ClientEdgeToClientObject",
        "concreteType": "CrucibleApp",
        "modelResolvers": null,
        "serverObjectOperations": null,
        "backingField": {
          "alias": null,
          "args": null,
          "fragment": null,
          "kind": "RelayResolver",
          "name": "app",
          "resolverModule": queryAppResolver,
          "path": "app",
          "normalizationInfo": {
            "kind": "WeakModel",
            "concreteType": "CrucibleApp",
            "plural": false
          }
        },
        "linkedField": {
          "alias": null,
          "args": null,
          "concreteType": "CrucibleApp",
          "kind": "LinkedField",
          "name": "app",
          "plural": false,
          "selections": [
            {
              "kind": "ClientEdgeToClientObject",
              "concreteType": "CrucibleStorage",
              "modelResolvers": null,
              "serverObjectOperations": null,
              "backingField": {
                "alias": null,
                "args": null,
                "fragment": (v0/*:: as any*/),
                "kind": "RelayResolver",
                "name": "storage",
                "resolverModule": resolverDataInjector(CrucibleApp____relay_model_instance_graphql, crucibleAppStorageResolver, '__relay_model_instance', true),
                "path": "app.storage",
                "normalizationInfo": {
                  "kind": "WeakModel",
                  "concreteType": "CrucibleStorage",
                  "plural": false
                }
              },
              "linkedField": {
                "alias": null,
                "args": null,
                "concreteType": "CrucibleStorage",
                "kind": "LinkedField",
                "name": "storage",
                "plural": false,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v1/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "persisted",
                    "resolverModule": resolverDataInjector(CrucibleStorage____relay_model_instance_graphql, crucibleStoragePersistedResolver, '__relay_model_instance', true),
                    "path": "app.storage.persisted"
                  },
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v1/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "usage",
                    "resolverModule": resolverDataInjector(CrucibleStorage____relay_model_instance_graphql, crucibleStorageUsageResolver, '__relay_model_instance', true),
                    "path": "app.storage.usage"
                  },
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v1/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "quota",
                    "resolverModule": resolverDataInjector(CrucibleStorage____relay_model_instance_graphql, crucibleStorageQuotaResolver, '__relay_model_instance', true),
                    "path": "app.storage.quota"
                  },
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v1/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "usageRatio",
                    "resolverModule": resolverDataInjector(CrucibleStorage____relay_model_instance_graphql, crucibleStorageUsageRatioResolver, '__relay_model_instance', true),
                    "path": "app.storage.usageRatio"
                  }
                ],
                "storageKey": null
              }
            },
            {
              "kind": "ClientEdgeToClientObject",
              "concreteType": "CrucibleSync",
              "modelResolvers": null,
              "serverObjectOperations": null,
              "backingField": {
                "alias": null,
                "args": null,
                "fragment": (v0/*:: as any*/),
                "kind": "RelayResolver",
                "name": "sync",
                "resolverModule": resolverDataInjector(CrucibleApp____relay_model_instance_graphql, crucibleAppSyncResolver, '__relay_model_instance', true),
                "path": "app.sync",
                "normalizationInfo": {
                  "kind": "WeakModel",
                  "concreteType": "CrucibleSync",
                  "plural": false
                }
              },
              "linkedField": {
                "alias": null,
                "args": null,
                "concreteType": "CrucibleSync",
                "kind": "LinkedField",
                "name": "sync",
                "plural": false,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v2/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "online",
                    "resolverModule": resolverDataInjector(CrucibleSync____relay_model_instance_graphql, crucibleSyncOnlineResolver, '__relay_model_instance', true),
                    "path": "app.sync.online"
                  },
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v2/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "status",
                    "resolverModule": resolverDataInjector(CrucibleSync____relay_model_instance_graphql, crucibleSyncStatusResolver, '__relay_model_instance', true),
                    "path": "app.sync.status"
                  },
                  {
                    "alias": null,
                    "args": null,
                    "fragment": (v2/*:: as any*/),
                    "kind": "RelayLiveResolver",
                    "name": "pendingMutations",
                    "resolverModule": resolverDataInjector(CrucibleSync____relay_model_instance_graphql, crucibleSyncPendingMutationsResolver, '__relay_model_instance', true),
                    "path": "app.sync.pendingMutations"
                  }
                ],
                "storageKey": null
              }
            }
          ],
          "storageKey": null
        }
      },
      (v3/*:: as any*/)
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "page_TodosQuery",
    "selections": [
      {
        "kind": "ClientEdgeToClientObject",
        "backingField": {
          "name": "app",
          "args": null,
          "fragment": null,
          "kind": "RelayResolver",
          "storageKey": null,
          "isOutputType": true
        },
        "linkedField": {
          "alias": null,
          "args": null,
          "concreteType": "CrucibleApp",
          "kind": "LinkedField",
          "name": "app",
          "plural": false,
          "selections": [
            {
              "kind": "ClientEdgeToClientObject",
              "backingField": {
                "name": "storage",
                "args": null,
                "fragment": (v5/*:: as any*/),
                "kind": "RelayResolver",
                "storageKey": null,
                "isOutputType": true
              },
              "linkedField": {
                "alias": null,
                "args": null,
                "concreteType": "CrucibleStorage",
                "kind": "LinkedField",
                "name": "storage",
                "plural": false,
                "selections": [
                  {
                    "name": "persisted",
                    "args": null,
                    "fragment": (v6/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  },
                  {
                    "name": "usage",
                    "args": null,
                    "fragment": (v6/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  },
                  {
                    "name": "quota",
                    "args": null,
                    "fragment": (v6/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  },
                  {
                    "name": "usageRatio",
                    "args": null,
                    "fragment": (v6/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  }
                ],
                "storageKey": null
              }
            },
            {
              "kind": "ClientEdgeToClientObject",
              "backingField": {
                "name": "sync",
                "args": null,
                "fragment": (v5/*:: as any*/),
                "kind": "RelayResolver",
                "storageKey": null,
                "isOutputType": true
              },
              "linkedField": {
                "alias": null,
                "args": null,
                "concreteType": "CrucibleSync",
                "kind": "LinkedField",
                "name": "sync",
                "plural": false,
                "selections": [
                  {
                    "name": "online",
                    "args": null,
                    "fragment": (v7/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  },
                  {
                    "name": "status",
                    "args": null,
                    "fragment": (v7/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  },
                  {
                    "name": "pendingMutations",
                    "args": null,
                    "fragment": (v7/*:: as any*/),
                    "kind": "RelayResolver",
                    "storageKey": null,
                    "isOutputType": true
                  }
                ],
                "storageKey": null
              }
            }
          ],
          "storageKey": null
        }
      },
      (v3/*:: as any*/)
    ]
  },
  "params": {
    "cacheID": "4747bacbb3c22086f1d3638cbde7290c",
    "id": "4747bacbb3c22086f1d3638cbde7290c",
    "metadata": {},
    "name": "page_TodosQuery",
    "operationKind": "query",
    "text": "query page_TodosQuery {\n  todos(first: 50) {\n    edges {\n      node {\n        id\n        databaseId\n        title\n        completed\n        updatedAt\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "c620106f745a6f5129e7e0cd18c33fab";

import { PreloadableQueryRegistry } from 'relay-runtime';
PreloadableQueryRegistry.set(node.params.id, node);

export default node;

/**
 * @generated SignedSource<<8e7ba374004226039426680007e09c6d>>
 * @relayHash 7963f843a7337841379d7d4ee3103acc
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

// @relayRequestID 7963f843a7337841379d7d4ee3103acc

import type { ConcreteRequest } from 'relay-runtime';
export type subscriptionProof_TodoEventsSubscription$variables = Record<PropertyKey, never>;
export type subscriptionProof_TodoEventsSubscription$data = {
  readonly todoEvent: {
    readonly emittedAt: string;
    readonly eventId: string;
    readonly kind: string;
    readonly message: string;
    readonly sourceTab: string;
    readonly todo: {
      readonly id: string;
      readonly title: string;
    };
  };
};
export type subscriptionProof_TodoEventsSubscription = {
  response: subscriptionProof_TodoEventsSubscription$data;
  variables: subscriptionProof_TodoEventsSubscription$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "TodoEvent",
    "kind": "LinkedField",
    "name": "todoEvent",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "eventId",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "kind",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "message",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "emittedAt",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "sourceTab",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "Todo",
        "kind": "LinkedField",
        "name": "todo",
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
            "name": "title",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "subscriptionProof_TodoEventsSubscription",
    "selections": (v0/*:: as any*/),
    "type": "Subscription",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "subscriptionProof_TodoEventsSubscription",
    "selections": (v0/*:: as any*/)
  },
  "params": {
    "cacheID": "7963f843a7337841379d7d4ee3103acc",
    "id": "7963f843a7337841379d7d4ee3103acc",
    "metadata": {},
    "name": "subscriptionProof_TodoEventsSubscription",
    "operationKind": "subscription",
    "text": "subscription subscriptionProof_TodoEventsSubscription {\n  todoEvent {\n    eventId\n    kind\n    message\n    emittedAt\n    sourceTab\n    todo {\n      id\n      title\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "8fc3a2bebe8ab6512ef02870710f9c7b";

export default node;

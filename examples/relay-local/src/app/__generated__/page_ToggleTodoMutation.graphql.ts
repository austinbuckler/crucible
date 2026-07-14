/**
 * @generated SignedSource<<f6007651da60a4a363c3ca5bacc2a94a>>
 * @relayHash 9173ff2a1c8fdfe4f68a09669b816664
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

// @relayRequestID 9173ff2a1c8fdfe4f68a09669b816664

import type { ConcreteRequest } from 'relay-runtime';
export type page_ToggleTodoMutation$variables = {
  databaseId: string;
};
export type page_ToggleTodoMutation$data = {
  readonly toggleTodo: {
    readonly completed: boolean;
    readonly databaseId: string;
    readonly id: string;
    readonly title: string;
    readonly updatedAt: string;
  };
};
export type page_ToggleTodoMutation = {
  response: page_ToggleTodoMutation$data;
  variables: page_ToggleTodoMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "databaseId"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "databaseId",
        "variableName": "databaseId"
      }
    ],
    "concreteType": "Todo",
    "kind": "LinkedField",
    "name": "toggleTodo",
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
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "page_ToggleTodoMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "page_ToggleTodoMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "9173ff2a1c8fdfe4f68a09669b816664",
    "id": "9173ff2a1c8fdfe4f68a09669b816664",
    "metadata": {},
    "name": "page_ToggleTodoMutation",
    "operationKind": "mutation",
    "text": "mutation page_ToggleTodoMutation(\n  $databaseId: String!\n) {\n  toggleTodo(databaseId: $databaseId) {\n    id\n    databaseId\n    title\n    completed\n    updatedAt\n  }\n}\n"
  }
};
})();

(node as any).hash = "cb74c987526dc8107f0eb189c3a0cc7b";

export default node;

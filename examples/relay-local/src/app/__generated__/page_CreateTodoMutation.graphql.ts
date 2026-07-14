/**
 * @generated SignedSource<<5f50d47b5d01098cd53111f5b3524460>>
 * @relayHash 4d5db0d51c685d3b8b32a4996c80e488
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

// @relayRequestID 4d5db0d51c685d3b8b32a4996c80e488

import type { ConcreteRequest } from 'relay-runtime';
export type page_CreateTodoMutation$variables = {
  title: string;
};
export type page_CreateTodoMutation$data = {
  readonly createTodo: {
    readonly completed: boolean;
    readonly databaseId: string;
    readonly id: string;
    readonly title: string;
    readonly updatedAt: string;
  };
};
export type page_CreateTodoMutation = {
  response: page_CreateTodoMutation$data;
  variables: page_CreateTodoMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "title"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "title",
        "variableName": "title"
      }
    ],
    "concreteType": "Todo",
    "kind": "LinkedField",
    "name": "createTodo",
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
    "name": "page_CreateTodoMutation",
    "selections": (v1/*:: as any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*:: as any*/),
    "kind": "Operation",
    "name": "page_CreateTodoMutation",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "4d5db0d51c685d3b8b32a4996c80e488",
    "id": "4d5db0d51c685d3b8b32a4996c80e488",
    "metadata": {},
    "name": "page_CreateTodoMutation",
    "operationKind": "mutation",
    "text": "mutation page_CreateTodoMutation(\n  $title: String!\n) {\n  createTodo(title: $title) {\n    id\n    databaseId\n    title\n    completed\n    updatedAt\n  }\n}\n"
  }
};
})();

(node as any).hash = "eb177d3dff1a454318a7818af06f028c";

export default node;

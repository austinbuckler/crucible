/**
 * @generated SignedSource<<edf35ce86b1bf8b1688624fce6380e6a>>
 * @relayHash 4747bacbb3c22086f1d3638cbde7290c
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

// @relayRequestID 4747bacbb3c22086f1d3638cbde7290c

import type { ConcreteRequest } from 'relay-runtime';
export type page_TodosQuery$variables = Record<PropertyKey, never>;
export type page_TodosQuery$data = {
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

const node: ConcreteRequest = (function(){
var v0 = [
  {
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
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "page_TodosQuery",
    "selections": (v0/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "page_TodosQuery",
    "selections": (v0/*:: as any*/)
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

(node as any).hash = "61c53e13bb9e986b151ff965dae4dc0b";

import { PreloadableQueryRegistry } from 'relay-runtime';
PreloadableQueryRegistry.set(node.params.id, node);

export default node;

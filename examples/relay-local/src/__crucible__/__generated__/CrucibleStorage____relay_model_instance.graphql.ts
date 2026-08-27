/**
 * @generated SignedSource<<b04b09a38dfa477ac0c9b7f799745136>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import type { ReaderFragment } from 'relay-runtime';
import type { CrucibleStorage } from "../app-resolvers";
import type { FragmentRefs } from "relay-runtime";
export type CrucibleStorage____relay_model_instance$data = {
  readonly __relay_model_instance: CrucibleStorage;
  readonly " $fragmentType": "CrucibleStorage____relay_model_instance";
};
export type CrucibleStorage____relay_model_instance$key = {
  readonly " $data"?: CrucibleStorage____relay_model_instance$data;
  readonly " $fragmentSpreads": FragmentRefs<"CrucibleStorage____relay_model_instance">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "CrucibleStorage____relay_model_instance",
  "selections": [
    {
      "kind": "ClientExtension",
      "selections": [
        {
          "alias": null,
          "args": null,
          "kind": "ScalarField",
          "name": "__relay_model_instance",
          "storageKey": null
        }
      ]
    }
  ],
  "type": "CrucibleStorage",
  "abstractKey": null
};

export default node;

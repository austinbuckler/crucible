/**
 * @generated SignedSource<<bff47fff1f2c353730932bc76bc72842>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import type { ReaderFragment } from 'relay-runtime';
import type { CrucibleApp } from "../app-resolvers";
import type { FragmentRefs } from "relay-runtime";
export type CrucibleApp____relay_model_instance$data = {
  readonly __relay_model_instance: CrucibleApp;
  readonly " $fragmentType": "CrucibleApp____relay_model_instance";
};
export type CrucibleApp____relay_model_instance$key = {
  readonly " $data"?: CrucibleApp____relay_model_instance$data;
  readonly " $fragmentSpreads": FragmentRefs<"CrucibleApp____relay_model_instance">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "CrucibleApp____relay_model_instance",
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
  "type": "CrucibleApp",
  "abstractKey": null
};

export default node;

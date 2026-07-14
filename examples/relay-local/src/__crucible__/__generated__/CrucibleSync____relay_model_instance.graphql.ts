/**
 * @generated SignedSource<<9e607050de477e8cc75ec7513e2b2398>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import type { ReaderFragment } from 'relay-runtime';
import type { CrucibleSync } from "../app-resolvers";
import type { FragmentRefs } from "relay-runtime";
export type CrucibleSync____relay_model_instance$data = {
  readonly __relay_model_instance: CrucibleSync;
  readonly " $fragmentType": "CrucibleSync____relay_model_instance";
};
export type CrucibleSync____relay_model_instance$key = {
  readonly " $data"?: CrucibleSync____relay_model_instance$data;
  readonly " $fragmentSpreads": FragmentRefs<"CrucibleSync____relay_model_instance">;
};

const node: ReaderFragment = {
  "argumentDefinitions": [],
  "kind": "Fragment",
  "metadata": null,
  "name": "CrucibleSync____relay_model_instance",
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
  "type": "CrucibleSync",
  "abstractKey": null
};

export default node;

/**
 * Bridge Kit vendor bundle entry — bundled to an IIFE (classic script) by
 * scripts/build.js so the vanilla-JS app can use the Circle Bridge Kit SDK
 * without a module bundler at runtime.
 *
 * This file is ONLY a re-export shim. It must never be loaded directly.
 */
import {
  BridgeKit,
  Blockchain,
  TransferSpeed,
  isRetryableError,
  isFatalError,
  isNetworkError,
} from '@circle-fin/bridge-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';

window.__BridgeKitVendor = {
  BridgeKit,
  Blockchain,
  TransferSpeed,
  createViemAdapterFromProvider,
  isRetryableError,
  isFatalError,
  isNetworkError,
};

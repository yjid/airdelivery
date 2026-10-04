'use client';

/**
 * WebRTC + transfer context.
 *
 * Two performance fixes:
 *
 *  - `actions` was memoised against a dependency list of functions that were
 *    recreated on every render (because `useWebRTC` did not memoise them), so
 *    the memo never hit and every consumer re-rendered on every tick of the
 *    1-second metrics interval. `useWebRTC` now returns `useCallback`-wrapped
 *    functions, so the memo is actually effective.
 *
 *  - `state` was rebuilt as a fresh object literal on every render. It is now
 *    memoised, so a metrics update only re-renders consumers that read it.
 *
 * `dataChannel` and `controlChannel` are exposed as state rather than refs. A ref
 * mutation does not trigger a render, so consumers previously only ever saw a
 * channel because an unrelated `setStatus` happened to fire first — which is a
 * race, not a guarantee.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useFileTransfer } from '@/hooks/useFileTransfer';
import { useWebRTC } from '@/hooks/useWebRTC';

type WebRTCState = {
  flightId: string;
  queue: ReturnType<typeof useFileTransfer>['queue'];
  recvQueue: ReturnType<typeof useFileTransfer>['recvQueue'];
  metrics: ReturnType<typeof useFileTransfer>['metrics'];
  status: ReturnType<typeof useWebRTC>['status'];
  failure: ReturnType<typeof useWebRTC>['failure'];
  members: ReturnType<typeof useWebRTC>['members'];
  nearByUsers: ReturnType<typeof useWebRTC>['members'];
  dataChannel: ReturnType<typeof useWebRTC>['dataChannel'];
  controlChannel: ReturnType<typeof useWebRTC>['controlChannel'];
};

type WebRTCActions = {
  connectToFlight: (id: string) => void;
  leaveFlight: () => void;
  refreshNearby: ReturnType<typeof useWebRTC>['refreshNearby'];
  inviteToFlight: ReturnType<typeof useWebRTC>['inviteToFlight'];
  requestDirectConnect: ReturnType<typeof useWebRTC>['requestDirectConnect'];
  restartIce: ReturnType<typeof useWebRTC>['restartIce'];
  handleFileSelect: ReturnType<typeof useFileTransfer>['handleFileSelect'];
  enqueueFiles: ReturnType<typeof useFileTransfer>['enqueueFiles'];
  cancelTransfer: ReturnType<typeof useFileTransfer>['cancelTransfer'];
  pauseTransfer: ReturnType<typeof useFileTransfer>['pauseTransfer'];
  resumeTransfer: ReturnType<typeof useFileTransfer>['resumeTransfer'];
  downloadFile: ReturnType<typeof useFileTransfer>['downloadFile'];
  releaseUrls: ReturnType<typeof useFileTransfer>['releaseUrls'];
  resetTransfer: ReturnType<typeof useFileTransfer>['reset'];
  cancelReceive: ReturnType<typeof useFileTransfer>['cancelReceive'];
};

const WebRTCStateContext = createContext<WebRTCState | null>(null);
const WebRTCActionsContext = createContext<WebRTCActions | null>(null);

export const WebRTCProvider = ({ children }: { children: ReactNode }) => {
  const [flightId, setFlightId] = useState('');

  const webRTC = useWebRTC(() => {
    // Messages are routed by useFileTransfer's own listener, which is attached
    // to the channels directly. This callback exists so a future transport can
    // feed the same pipeline.
  });

  const fileTrans = useFileTransfer({
    dataChannel: webRTC.dataChannel,
    controlChannel: webRTC.controlChannel,
    peer: webRTC.peerRef,
    onDisconnect: webRTC.disconnect,
    onStats: webRTC.updateStats,
    config: null,
  });

  // Destructured so the dependency list names stable identities rather than the
  // hook return objects, which are new on every render and would defeat the
  // memo entirely.
  const {
    connectToFlight: rtcConnect,
    disconnect: rtcDisconnect,
    refreshNearby: rtcRefreshNearby,
    inviteToFlight: rtcInvite,
    requestDirectConnect: rtcRequestConnect,
    restartIce: rtcRestartIce,
  } = webRTC;

  const {
    handleFileSelect: transferHandleFileSelect,
    enqueueFiles: transferEnqueue,
    cancelTransfer: transferCancelSend,
    pauseTransfer: transferPause,
    resumeTransfer: transferResume,
    downloadFile: transferDownload,
    releaseUrls: transferReleaseUrls,
    reset: transferReset,
    cancelReceive: transferCancelReceive,
  } = fileTrans;

  const actions = useMemo<WebRTCActions>(
    () => ({
      connectToFlight: (id: string) => {
        setFlightId(id.toUpperCase());
        rtcConnect(id);
      },
      leaveFlight: () => {
        // Release object URLs before dropping state, or every received blob
        // stays resident until the document unloads — which is how a long
        // session on a phone ends in an OOM.
        transferReleaseUrls();
        transferReset();
        rtcDisconnect();
        setFlightId('');
      },
      refreshNearby: rtcRefreshNearby,
      inviteToFlight: rtcInvite,
      requestDirectConnect: rtcRequestConnect,
      restartIce: rtcRestartIce,
      handleFileSelect: transferHandleFileSelect,
      enqueueFiles: transferEnqueue,
      cancelTransfer: transferCancelSend,
      pauseTransfer: transferPause,
      resumeTransfer: transferResume,
      downloadFile: transferDownload,
      releaseUrls: transferReleaseUrls,
      resetTransfer: transferReset,
      cancelReceive: transferCancelReceive,
    }),
    [
      rtcConnect,
      rtcDisconnect,
      rtcInvite,
      rtcRefreshNearby,
      rtcRequestConnect,
      rtcRestartIce,
      transferCancelReceive,
      transferCancelSend,
      transferDownload,
      transferEnqueue,
      transferHandleFileSelect,
      transferPause,
      transferReleaseUrls,
      transferReset,
      transferResume,
    ],
  );

  const state = useMemo<WebRTCState>(
    () => ({
      flightId,
      queue: fileTrans.queue,
      recvQueue: fileTrans.recvQueue,
      metrics: fileTrans.metrics,
      status: webRTC.status,
      failure: webRTC.failure,
      members: webRTC.members,
      nearByUsers: webRTC.nearByUsers,
      dataChannel: webRTC.dataChannel,
      controlChannel: webRTC.controlChannel,
    }),
    [
      fileTrans.metrics,
      fileTrans.queue,
      fileTrans.recvQueue,
      flightId,
      webRTC.controlChannel,
      webRTC.dataChannel,
      webRTC.failure,
      webRTC.members,
      webRTC.nearByUsers,
      webRTC.status,
    ],
  );

  return (
    <WebRTCStateContext.Provider value={state}>
      <WebRTCActionsContext.Provider value={actions}>{children}</WebRTCActionsContext.Provider>
    </WebRTCStateContext.Provider>
  );
};

export const useWebRTCState = () => {
  const ctx = useContext(WebRTCStateContext);
  if (!ctx) throw new Error('useWebRTCState must be used inside <WebRTCProvider>');
  return ctx;
};

export const useWebRTCActions = () => {
  const ctx = useContext(WebRTCActionsContext);
  if (!ctx) throw new Error('useWebRTCActions must be used inside <WebRTCProvider>');
  return ctx;
};

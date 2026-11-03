import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { TransferItemCard } from './components/TransferItemCard';
import { IncomingTransferModal } from './components/IncomingTransferModal';
import { NetworkInfoModal } from './components/NetworkInfoModal';
import { WifiScannerHub } from './components/WifiScannerHub';
import { DirectIpConnectBar } from './components/DirectIpConnectBar';
import { Language, translations } from './translations';
import {
  PeerInfo,
  TransferItem,
  IncomingOffer,
  SharedTextItem,
  LocalNetworkInfo,
} from './types';
import { PeerConnectionManager, SignalData } from './utils/webrtc';
import { playIncomingAlert, playCompletionChime } from './utils/audio';
import { saveBlobToChosenDirectoryOrDownload, extractFilesFromDataTransfer } from './utils/fileSystem';
import { formatBytes, formatSpeed } from './utils/format';
import { UploadCloud, Wifi, HardDrive, CheckCircle2, Zap, X, Pause, Play } from 'lucide-react';

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for ultra-fast throughput

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
}

function getInitialDeviceType(): 'desktop' | 'laptop' | 'mobile' {
  if (typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent.toLowerCase();
  if (/mobile|android|iphone|ipad|tablet/.test(ua)) return 'mobile';
  if (window.innerWidth < 1024) return 'laptop';
  return 'desktop';
}

function getInitialDeviceName(): string {
  if (typeof window === 'undefined') return 'PC / Laptop';
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows PC (Wi-Fi Dongle)';
  if (/Mac/.test(ua)) return 'MacBook (Wi-Fi)';
  if (/Linux/.test(ua)) return 'Linux PC (LAN)';
  return 'PC / Laptop';
}

export default function App() {
  const [lang, setLang] = useState<Language>('bn');
  const t = translations[lang];

  // Self identity
  const [selfInfo, setSelfInfo] = useState<PeerInfo>(() => {
    const savedName = localStorage.getItem('lan_device_name') || getInitialDeviceName();
    const savedType = (localStorage.getItem('lan_device_type') as any) || getInitialDeviceType();
    const savedTag = localStorage.getItem('lan_network_tag') || 'Wi-Fi Dongle';
    return {
      id: generateId(),
      name: savedName,
      deviceType: savedType,
      os: 'Windows',
      networkTag: savedTag,
      targetDrives: ['Desktop', 'C:\\', 'D:\\', 'E:\\', 'Downloads'],
      roomId: 'local-mesh',
      joinedAt: Date.now(),
    };
  });

  // State
  const [isConnected, setIsConnected] = useState(false);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [pairedPeerId, setPairedPeerId] = useState<string | null>(null);
  const [connectingPeerId, setConnectingPeerId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState<string>('local-mesh');
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [sharedTexts, setSharedTexts] = useState<SharedTextItem[]>([]);
  const [networkInfo, setNetworkInfo] = useState<LocalNetworkInfo | null>(null);
  const [isNetworkModalOpen, setIsNetworkModalOpen] = useState(false);
  const [isGlobalDragging, setIsGlobalDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const activeTargetPathRef = useRef<string>('Desktop');

  // Real-time batch transfer speed tracking
  const [liveBatchSpeed, setLiveBatchSpeed] = useState<number>(0);
  const lastThroughputRef = useRef<{ bytes: number; time: number; speed: number }>({
    bytes: 0,
    time: Date.now(),
    speed: 0,
  });

  // Transfer pause & resume state
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);
  isPausedRef.current = isPaused;

  // Refs for WebRTC, WebSocket and active transfer buffers
  const selfInfoRef = useRef(selfInfo);
  selfInfoRef.current = selfInfo;

  const wsRef = useRef<WebSocket | null>(null);
  const rtcManagerRef = useRef<PeerConnectionManager | null>(null);
  const switchWsHostRef = useRef<((host: string, targetPeerId?: string) => void) | null>(null);
  
  // Streaming zero-memory buffer for receiving files: transferId -> streaming metadata
  const incomingBuffersRef = useRef<
    Map<
      string,
      {
        receivedBytes: number;
        writtenOffset: number;
        pendingParts: ArrayBuffer[];
        pendingBytes: number;
        fileSize: number;
        fileName: string;
        fileType: string;
        targetDrive: string;
        peerName: string;
        lastUpdate: number;
        lastBytes: number;
      }
    >
  >(new Map());

  // Outgoing transfer cancel tokens: transferId -> boolean
  const cancelledTransfersRef = useRef<Set<string>>(new Set());
  const activeSendingTransfersRef = useRef<Set<string>>(new Set());

  // Fetch local network info from Express backend
  useEffect(() => {
    fetch('/api/network-info')
      .then((res) => res.json())
      .then((data: LocalNetworkInfo) => {
        setNetworkInfo(data);
        // Select authentic LAN IP, strictly filtering out dummy APIPA (169.254.x.x), loopback and virtual adapters
        const isRealIp = (ip?: string) => Boolean(ip && !ip.startsWith('169.254.') && !ip.startsWith('127.') && ip !== '0.0.0.0' && ip !== '192.168.1.x');

        const realIps = (data.localIps || []).filter(
          (net) => isRealIp(net.address)
        );

        const validLanIp =
          (isRealIp(data.primaryIp) ? data.primaryIp : undefined) ||
          realIps.find((net) => net.address.startsWith('192.168.'))?.address ||
          realIps.find((net) => net.address.startsWith('10.'))?.address ||
          realIps.find((net) => /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(net.address))?.address ||
          realIps[0]?.address;

        setSelfInfo((prev) => {
          const updated = {
            ...prev,
            ip: validLanIp || prev.ip,
            targetDrives: data.drives && data.drives.length > 0 ? data.drives : prev.targetDrives,
          };
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({
                type: 'update:profile',
                name: updated.name,
                ip: updated.ip,
                targetDrives: updated.targetDrives,
                networkTag: updated.networkTag,
              })
            );
          }
          return updated;
        });
      })
      .catch((err) => console.warn('Could not fetch network info:', err));
  }, []);

  // Smooth real-time batch transfer speed calculation
  useEffect(() => {
    const hasActive = transfers.some(
      (t) => t.status === 'transferring' || t.status === 'waiting_approval'
    );
    if (!hasActive) {
      if (liveBatchSpeed !== 0 && transfers.length === 0) {
        setLiveBatchSpeed(0);
      }
      return;
    }

    const timer = setInterval(() => {
      const totalTransferred = transfers.reduce(
        (acc, t) => acc + (t.status === 'completed' ? (t.fileSize || 0) : (t.transferredBytes || 0)),
        0
      );
      const now = Date.now();
      const timeDiff = (now - lastThroughputRef.current.time) / 1000;
      const bytesDiff = totalTransferred - lastThroughputRef.current.bytes;

      if (timeDiff >= 0.35 && bytesDiff >= 0) {
        const measured = bytesDiff / timeDiff;
        const activeSum = transfers.reduce(
          (acc, t) => acc + (t.status === 'transferring' ? (t.speedBytesPerSec || 0) : 0),
          0
        );
        const resolved = Math.max(measured, activeSum);
        if (resolved > 0) {
          lastThroughputRef.current.speed = resolved;
          setLiveBatchSpeed(resolved);
        } else if (lastThroughputRef.current.speed > 0) {
          lastThroughputRef.current.speed *= 0.85;
          setLiveBatchSpeed(lastThroughputRef.current.speed);
        }
        lastThroughputRef.current.bytes = totalTransferred;
        lastThroughputRef.current.time = now;
      }
    }, 400);

    return () => clearInterval(timer);
  }, [transfers, liveBatchSpeed]);

  // Send message helper
  const sendWsMessage = useCallback((msg: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Send WebRTC signal helper
  const handleSendSignal = useCallback(
    (targetId: string, data: SignalData) => {
      sendWsMessage({
        type: 'signal',
        fromId: selfInfo.id,
        targetId,
        data,
      });
    },
    [selfInfo.id, sendWsMessage]
  );

  // Batch completion sound helper (prevents duplicate audio alerts within 1.5s)
  const lastSoundTimeRef = useRef(0);
  const playBatchCompletionSound = useCallback(() => {
    const now = Date.now();
    if (now - lastSoundTimeRef.current < 1500) {
      return;
    }
    lastSoundTimeRef.current = now;
    playCompletionChime();
  }, []);

  // Handle data received over WebRTC Data Channel
  const handleDataChannelMessage = useCallback(
    (senderPeerId: string, data: ArrayBuffer | string) => {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'file:meta') {
            // Meta packet before binary chunks
            const existing = incomingBuffersRef.current.get(parsed.transferId);
            const resolvedTargetDrive = parsed.targetDrive || existing?.targetDrive || 'Desktop';
            incomingBuffersRef.current.set(parsed.transferId, {
              receivedBytes: existing?.receivedBytes || 0,
              writtenOffset: existing?.writtenOffset || 0,
              pendingParts: existing?.pendingParts || [],
              pendingBytes: existing?.pendingBytes || 0,
              fileSize: parsed.fileSize,
              fileName: parsed.fileName,
              fileType: parsed.fileType,
              targetDrive: resolvedTargetDrive,
              peerName: parsed.peerName || existing?.peerName || 'Connected PC',
              lastUpdate: Date.now(),
              lastBytes: 0,
            });
          } else if (parsed.type === 'batch:complete') {
            playBatchCompletionSound();
          }
        } catch {}
        return;
      }

      // Binary chunk received over WebRTC
      // Standard 36-byte transferId header in the binary chunk
      if (data.byteLength < 36) return;

      const headerBytes = new Uint8Array(data, 0, 36);
      const transferId = new TextDecoder().decode(headerBytes).trim();
      const chunkData = data.slice(36);

      handleReceivedChunk(transferId, chunkData, 'webrtc');
    },
    []
  );

  // Process a chunk of received file with Zero-Memory direct-to-disk streaming (WebRTC or WebSocket relay)
  const handleReceivedChunk = (
    transferId: string,
    chunkData: ArrayBuffer,
    mode: 'webrtc' | 'relay'
  ) => {
    const buf = incomingBuffersRef.current.get(transferId);
    if (!buf) return;

    buf.pendingParts.push(chunkData);
    buf.pendingBytes += chunkData.byteLength;
    buf.receivedBytes += chunkData.byteLength;

    const now = Date.now();
    const timeDiff = (now - buf.lastUpdate) / 1000;

    // Calculate speed every ~250ms
    let speed = 0;
    if (timeDiff >= 0.25) {
      const bytesDiff = buf.receivedBytes - buf.lastBytes;
      speed = bytesDiff / timeDiff;
      buf.lastUpdate = now;
      buf.lastBytes = buf.receivedBytes;
    }

    const progress = buf.fileSize > 0 ? Math.min(100, (buf.receivedBytes / buf.fileSize) * 100) : 100;
    const isCompleted = buf.receivedBytes >= buf.fileSize;

    // Zero-Memory Flush: write directly to disk via /api/upload-chunk whenever batch reaches 2 MB or upon completion
    if (buf.pendingBytes >= 2 * 1024 * 1024 || isCompleted) {
      const currentOffset = buf.writtenOffset;
      const partsToFlush = buf.pendingParts;
      const bytesToFlush = buf.pendingBytes;

      // Free RAM immediately: chunks are discarded from browser memory
      buf.pendingParts = [];
      buf.pendingBytes = 0;
      buf.writtenOffset += bytesToFlush;

      const batchBlob = new Blob(partsToFlush, { type: 'application/octet-stream' });

      fetch('/api/upload-chunk', {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent(buf.fileName),
          'x-target-path': encodeURIComponent(buf.targetDrive),
          'x-chunk-offset': currentOffset.toString(),
          'x-total-size': buf.fileSize.toString(),
          'x-is-last-chunk': isCompleted ? 'true' : 'false',
          'x-transfer-id': transferId,
          'x-sender-name': encodeURIComponent(buf.peerName),
        },
        body: batchBlob,
      }).catch((err) => {
        console.warn('[DirectDiskStream] Chunk flush error:', err);
      });
    }

    // Update UI state throttled
    setTransfers((prev) =>
      prev.map((item) => {
        if (item.transferId === transferId) {
          return {
            ...item,
            transferredBytes: buf.receivedBytes,
            progress,
            speedBytesPerSec: speed > 0 ? speed : item.speedBytesPerSec,
            mode,
            status: isCompleted ? 'completed' : 'transferring',
            endTime: isCompleted ? Date.now() : item.endTime,
          };
        }
        return item;
      })
    );

    if (isCompleted) {
      incomingBuffersRef.current.delete(transferId);
    }
  };

  // Safety tracker for receiver: when all incoming transfers reach 100% complete, play completion chime once
  const prevActiveIncomingRef = useRef(0);
  useEffect(() => {
    const activeIncoming = transfers.filter(
      (t) => t.direction === 'receive' && (t.status === 'transferring' || t.status === 'queued')
    ).length;
    const completedIncoming = transfers.filter(
      (t) => t.direction === 'receive' && t.status === 'completed'
    ).length;

    if (prevActiveIncomingRef.current > 0 && activeIncoming === 0 && completedIncoming > 0) {
      const timer = setTimeout(() => {
        const stillActive = transfers.some(
          (t) => t.direction === 'receive' && (t.status === 'transferring' || t.status === 'queued')
        );
        if (!stillActive) {
          playBatchCompletionSound();
        }
      }, 350);
      return () => clearTimeout(timer);
    }
    prevActiveIncomingRef.current = activeIncoming;
  }, [transfers, playBatchCompletionSound]);

  // Initialize WebRTC Manager
  useEffect(() => {
    rtcManagerRef.current = new PeerConnectionManager(
      selfInfo.id,
      handleSendSignal,
      handleDataChannelMessage
    );

    return () => {
      rtcManagerRef.current?.cleanupAll();
    };
  }, [selfInfo.id, handleSendSignal, handleDataChannelMessage]);

  // Connect WebSocket
  useEffect(() => {
    let reconnectTimer: any = null;
    let activeHost = window.location.host;
    let initialPairTarget: string | undefined;

    function connectWs(customHost?: string, pairTarget?: string) {
      if (customHost) {
        activeHost = customHost;
      }
      if (pairTarget) {
        initialPairTarget = pairTarget;
      }

      try {
        if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
          wsRef.current.close();
        }
      } catch {}

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${activeHost}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        // Announce device to the network room
        const info = selfInfoRef.current;
        ws.send(
          JSON.stringify({
            type: 'join',
            id: info.id,
            name: info.name,
            deviceType: info.deviceType,
            os: info.os,
            networkTag: info.networkTag,
            targetDrives: info.targetDrives,
            roomId: currentRoomId,
            ip: info.ip,
          })
        );

        if (initialPairTarget) {
          const target = initialPairTarget;
          initialPairTarget = undefined;
          ws.send(
            JSON.stringify({
              type: 'pair:request',
              fromPeer: info,
              targetId: target,
              autoAccept: true,
            })
          );
          rtcManagerRef.current?.initiateConnection(target);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'room:peers': {
              setPeers(msg.peers || []);
              if (msg.detectedIp) {
                setSelfInfo((prev) => {
                  if (prev.ip === msg.detectedIp) return prev;
                  return { ...prev, ip: msg.detectedIp };
                });
              }
              break;
            }

            case 'pair:ip-found': {
              if (msg.peer) {
                playCompletionChime();
                setPairedPeerId(msg.peer.id);
                setSelectedPeerId(msg.peer.id);
                setConnectingPeerId(null);
                rtcManagerRef.current?.initiateConnection(msg.peer.id);
              }
              break;
            }

            case 'peer:joined': {
              setPeers((prev) => {
                const filtered = prev.filter((p) => p.id !== msg.peer.id);
                return [...filtered, msg.peer];
              });
              break;
            }

            case 'peer:updated': {
              setPeers((prev) =>
                prev.map((p) => (p.id === msg.peer.id ? msg.peer : p))
              );
              break;
            }

            case 'peer:left': {
              setPeers((prev) => prev.filter((p) => p.id !== msg.peerId));
              rtcManagerRef.current?.cleanupPeer(msg.peerId);
              break;
            }

            case 'scan:response': {
              setPeers(msg.peers || []);
              setIsScanning(false);
              break;
            }

            case 'pair:request': {
              playIncomingAlert();
              const partnerId = msg.fromPeer?.id;
              if (partnerId) {
                setPairedPeerId(partnerId);
                setSelectedPeerId(partnerId);
                // Confirm pairing back
                sendWsMessage({
                  type: 'pair:accept',
                  fromId: selfInfo.id,
                  targetId: partnerId,
                });
                rtcManagerRef.current?.initiateConnection(partnerId);
              }
              break;
            }

            case 'pair:accepted': {
              playCompletionChime();
              const partnerId = msg.fromPeer?.id || msg.targetId;
              setPairedPeerId(partnerId);
              setSelectedPeerId(partnerId);
              setConnectingPeerId(null);
              break;
            }

            case 'pair:confirmed': {
              playCompletionChime();
              setPairedPeerId(msg.pairedWithId);
              setSelectedPeerId(msg.pairedWithId);
              setConnectingPeerId(null);
              break;
            }

            case 'pair:disconnected': {
              setPairedPeerId(null);
              setSelectedPeerId(null);
              setConnectingPeerId(null);
              break;
            }

            case 'signal': {
              rtcManagerRef.current?.handleSignal(msg.fromId, msg.data);
              break;
            }

            case 'file:offer': {
              // Another PC wants to send a file - alert on first incoming file of batch
              if (incomingBuffersRef.current.size === 0) {
                playIncomingAlert();
              }
              const sender = peers.find((p) => p.id === msg.fromId);
              const destinationPath = msg.file.suggestedDrive || 'Desktop';

              // Prepare local incoming streaming buffer
              incomingBuffersRef.current.set(msg.transferId, {
                receivedBytes: 0,
                writtenOffset: 0,
                pendingParts: [],
                pendingBytes: 0,
                fileSize: msg.file.size,
                fileName: msg.file.name,
                fileType: msg.file.type,
                targetDrive: destinationPath,
                peerName: sender?.name || 'Connected PC',
                lastUpdate: Date.now(),
                lastBytes: 0,
              });

              // Add item to transfers list on 2nd PC so real-time progress shows immediately
              setTransfers((prev) => {
                if (prev.some((item) => item.transferId === msg.transferId)) {
                  return prev;
                }
                return [
                  {
                    id: generateId(),
                    transferId: msg.transferId,
                    fileName: msg.file.name,
                    fileSize: msg.file.size,
                    fileType: msg.file.type,
                    direction: 'receive',
                    peerId: msg.fromId,
                    peerName: sender?.name || 'Connected PC',
                    progress: 0,
                    transferredBytes: 0,
                    speedBytesPerSec: 0,
                    status: 'transferring',
                    mode: 'webrtc',
                    sourceDrive: msg.file.sourceDrive,
                    targetDrive: destinationPath,
                    startTime: Date.now(),
                  },
                  ...prev,
                ];
              });

              // Auto-accept and reply to sender so file streaming begins immediately
              sendWsMessage({
                type: 'file:response',
                fromId: selfInfo.id,
                targetId: msg.fromId,
                transferId: msg.transferId,
                accepted: true,
                chosenDrive: destinationPath,
              });
              break;
            }

            case 'file:response': {
              // The recipient approved or declined
              if (msg.accepted) {
                if (msg.chosenDrive) {
                  setTransfers((prev) =>
                    prev.map((item) =>
                      item.transferId === msg.transferId
                        ? { ...item, targetDrive: msg.chosenDrive }
                        : item
                    )
                  );
                }
              } else {
                setTransfers((prev) =>
                  prev.map((item) =>
                    item.transferId === msg.transferId
                      ? { ...item, status: 'declined' }
                      : item
                  )
                );
              }
              break;
            }

            case 'file:relay:chunk': {
              // Fallback chunk via WebSocket
              // Binary data was converted to Base64 or array
              if (msg.data) {
                // Decode base64 to ArrayBuffer
                const binaryStr = atob(msg.data);
                const len = binaryStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                handleReceivedChunk(msg.transferId, bytes.buffer, 'relay');
              }
              break;
            }

            case 'file:cancel': {
              cancelledTransfersRef.current.add(msg.transferId);
              incomingBuffersRef.current.delete(msg.transferId);
              setTransfers((prev) =>
                prev.map((item) =>
                  item.transferId === msg.transferId
                    ? { ...item, status: 'cancelled' }
                    : item
                )
              );
              break;
            }

            case 'clipboard:received': {
              const sender = peers.find((p) => p.id === msg.fromId);
              setSharedTexts((prev) => [
                {
                  id: generateId(),
                  fromId: msg.fromId,
                  fromName: sender?.name || 'Remote PC',
                  text: msg.text,
                  timestamp: msg.timestamp || Date.now(),
                  isSelf: false,
                },
                ...prev.slice(0, 50),
              ]);
              break;
            }

            case 'open:folder:request': {
              fetch('/api/open-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: msg.path || 'Downloads' }),
              }).catch(() => {});
              break;
            }

            case 'file:progress': {
              setTransfers((prev) =>
                prev.map((item) => {
                  if (item.transferId === msg.transferId) {
                    return {
                      ...item,
                      transferredBytes: msg.transferredBytes,
                      progress: msg.progress,
                      speedBytesPerSec: msg.speedBytesPerSec,
                      status: 'transferring',
                    };
                  }
                  return item;
                })
              );
              break;
            }

            case 'file:pause_state': {
              setTransfers((prev) =>
                prev.map((item) => {
                  if (item.transferId === msg.transferId) {
                    return {
                      ...item,
                      status: msg.isPaused ? 'paused' : 'transferring',
                      speedBytesPerSec: msg.isPaused ? 0 : item.speedBytesPerSec,
                    };
                  }
                  return item;
                })
              );
              break;
            }

            case 'file:disk:received': {
              setTransfers((prev) => {
                const existing = prev.find((t) => (msg.transferId && t.transferId === msg.transferId) || (t.fileName === msg.fileName && t.direction === 'receive'));
                if (existing) {
                  return prev.map((t) =>
                    t.id === existing.id
                      ? { ...t, status: 'completed', progress: 100, transferredBytes: msg.fileSize, targetDrive: msg.targetDrive }
                      : t
                  );
                }
                return [
                  {
                    id: generateId(),
                    transferId: msg.transferId || generateId(),
                    fileName: msg.fileName,
                    fileSize: msg.fileSize,
                    fileType: 'application/octet-stream',
                    direction: 'receive',
                    peerId: 'remote',
                    peerName: msg.senderName || 'Connected PC',
                    progress: 100,
                    transferredBytes: msg.fileSize,
                    speedBytesPerSec: 0,
                    status: 'completed',
                    mode: 'webrtc',
                    targetDrive: msg.targetDrive,
                    startTime: Date.now() - 500,
                    endTime: Date.now(),
                  },
                  ...prev,
                ];
              });
              break;
            }

            case 'batch:complete': {
              playBatchCompletionSound();
              break;
            }
          }
        } catch (err) {
          console.error('WebSocket parse error:', err);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        reconnectTimer = setTimeout(connectWs, 2000);
      };

      ws.onerror = () => {
        setIsConnected(false);
      };
    }

    switchWsHostRef.current = (host: string, targetPeerId?: string) => {
      connectWs(host, targetPeerId);
    };

    connectWs();

    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [currentRoomId]);

  // Active files stored in memory for sender: transferId -> File
  const pendingFilesRef = useRef<Map<string, File>>(new Map());

  // Serial transfer queue to process files sequentially from top to bottom
  interface SendQueueTask {
    transferId: string;
    targetId: string;
    targetDrive: string;
    sourceDrive: string;
    file: File;
    filePath: string;
  }

  const sendQueueRef = useRef<SendQueueTask[]>([]);
  const isProcessingQueueRef = useRef(false);

  // Serial queue processor: runs transfers strictly one by one in top-to-bottom sequence
  const processSendQueue = async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;

    const targetsInBatch = new Set<string>();
    let anyCompleted = false;

    while (sendQueueRef.current.length > 0) {
      while (isPausedRef.current) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const task = sendQueueRef.current.shift();
      if (!task) break;

      targetsInBatch.add(task.targetId);

      // Skip if cancelled while waiting in queue
      if (cancelledTransfersRef.current.has(task.transferId)) {
        pendingFilesRef.current.delete(task.transferId);
        continue;
      }

      // Mark the current task as transferring
      setTransfers((prev) =>
        prev.map((item) =>
          item.transferId === task.transferId
            ? { ...item, status: 'transferring' }
            : item
        )
      );

      // Send transfer offer to recipient
      sendWsMessage({
        type: 'file:offer',
        fromId: selfInfoRef.current.id,
        targetId: task.targetId,
        transferId: task.transferId,
        file: {
          name: task.filePath,
          size: task.file.size,
          type: task.file.type,
          sourceDrive: task.sourceDrive,
          suggestedDrive: task.targetDrive,
        },
      });

      // Stream file sequentially and wait until it fully completes or finishes
      await startSendingFile(
        task.transferId,
        task.targetId,
        task.targetDrive,
        task.file,
        task.filePath
      );

      if (!cancelledTransfersRef.current.has(task.transferId)) {
        anyCompleted = true;
      }
    }

    isProcessingQueueRef.current = false;

    // Entire batch is now 100% complete! Play completion sound once
    if (anyCompleted) {
      setIsPaused(false);
      isPausedRef.current = false;
      playBatchCompletionSound();

      // Notify recipient peer(s) that the full batch is 100% complete
      for (const targetId of targetsInBatch) {
        sendWsMessage({
          type: 'batch:complete',
          fromId: selfInfoRef.current.id,
          targetId,
        });

        // Also notify via WebRTC DataChannel if open
        const dc = rtcManagerRef.current?.getDataChannel(targetId);
        if (dc && dc.readyState === 'open') {
          try {
            dc.send(JSON.stringify({ type: 'batch:complete' }));
          } catch {}
        }
      }
    }
  };

  // Toggle Pause / Resume for ongoing file transfers
  const togglePauseResume = useCallback(() => {
    setIsPaused((prev) => {
      const next = !prev;
      isPausedRef.current = next;
      setTransfers((curr) => {
        // Send pause state to active peer(s)
        for (const item of curr) {
          if (item.status === 'transferring' || item.status === 'paused') {
            sendWsMessage({
              type: 'file:pause_state',
              targetId: item.peerId,
              transferId: item.transferId,
              isPaused: next,
            });
          }
        }
        return curr.map((item) => {
          if (next && item.status === 'transferring') {
            return { ...item, status: 'paused', speedBytesPerSec: 0 };
          }
          if (!next && item.status === 'paused') {
            return { ...item, status: 'transferring' };
          }
          return item;
        });
      });
      if (!next && !isProcessingQueueRef.current && sendQueueRef.current.length > 0) {
        processSendQueue();
      }
      return next;
    });
  }, [sendWsMessage]);

  // Function to initiate file sending
  const handleSendFiles = (
    files: File[],
    targetPeerIds: string[],
    sourceDrive: string,
    targetDrive: string
  ) => {
    const newItems: TransferItem[] = [];

    // Queue files strictly in top-to-bottom order
    for (const file of files) {
      for (const targetId of targetPeerIds) {
        const transferId = generateId();
        pendingFilesRef.current.set(transferId, file);
        const filePath = (file as any).relativePath || file.webkitRelativePath || file.name;
        const targetPeer = peers.find((p) => p.id === targetId);

        // Pre-warm WebRTC connection in background
        rtcManagerRef.current?.initiateConnection(targetId);

        newItems.push({
          id: generateId(),
          transferId,
          fileName: filePath,
          fileSize: file.size,
          fileType: file.type,
          direction: 'send',
          peerId: targetId,
          peerName: targetPeer?.name || 'Remote PC',
          progress: 0,
          transferredBytes: 0,
          speedBytesPerSec: 0,
          status: 'queued', // Initially queued, will become transferring sequentially
          mode: 'webrtc',
          sourceDrive,
          targetDrive,
          startTime: Date.now(),
        });

        sendQueueRef.current.push({
          transferId,
          targetId,
          targetDrive,
          sourceDrive,
          file,
          filePath,
        });
      }
    }

    // Append so files appear and process in exact top-to-bottom order
    setTransfers((prev) => [...prev, ...newItems]);

    // Kick off serial queue processor
    processSendQueue();
  };

  // Start reading file in chunks and streaming to recipient
  const startSendingFile = (
    transferId: string,
    targetPeerId: string,
    targetDrive: string,
    file: File,
    filePath: string
  ): Promise<void> => {
    return new Promise<void>((resolve) => {
      let isDone = false;
      const finish = () => {
        if (!isDone) {
          isDone = true;
          activeSendingTransfersRef.current.delete(transferId);
          pendingFilesRef.current.delete(transferId);
          resolve();
        }
      };

      if (cancelledTransfersRef.current.has(transferId)) {
        finish();
        return;
      }

      activeSendingTransfersRef.current.add(transferId);

      setTransfers((prev) =>
        prev.map((item) =>
          item.transferId === transferId
            ? { ...item, status: 'transferring', targetDrive }
            : item
        )
      );

      // Helper to stream chunks via WebRTC DataChannel or WebSocket relay
      const streamOverDataChannelOrRelay = async () => {
        const useWebRtc = rtcManagerRef.current?.isDataChannelOpen(targetPeerId);
        const dc = useWebRtc ? rtcManagerRef.current?.getDataChannel(targetPeerId) : null;
        const mode = dc ? 'webrtc' : 'relay';

        if (dc && dc.readyState === 'open') {
          dc.send(
            JSON.stringify({
              type: 'file:meta',
              transferId,
              fileName: filePath,
              fileSize: file.size,
              fileType: file.type,
              targetDrive,
              peerName: selfInfoRef.current.name,
            })
          );
        }

        let offset = 0;
        let lastTime = Date.now();
        let lastOffset = 0;

        const idEncoder = new TextEncoder();
        const idBytes = new Uint8Array(36);
        idBytes.set(idEncoder.encode(transferId.padEnd(36)));

        while (offset < file.size) {
          if (cancelledTransfersRef.current.has(transferId)) {
            finish();
            return;
          }

          while (isPausedRef.current) {
            if (cancelledTransfersRef.current.has(transferId)) {
              finish();
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
            lastTime = Date.now();
            lastOffset = offset;
          }

          const chunkSlice = file.slice(offset, offset + CHUNK_SIZE);
          const chunkBuffer = await chunkSlice.arrayBuffer();

          if (dc && dc.readyState === 'open') {
            // Adaptive zero-lag flow control with WebRTC bufferedamountlow
            if (dc.bufferedAmount > 1024 * 1024) {
              dc.bufferedAmountLowThreshold = 256 * 1024;
              await new Promise<void>((resWait) => {
                const onLow = () => {
                  dc.removeEventListener('bufferedamountlow', onLow);
                  resWait();
                };
                dc.addEventListener('bufferedamountlow', onLow);
                setTimeout(() => {
                  dc.removeEventListener('bufferedamountlow', onLow);
                  resWait();
                }, 40);
              });

              if (cancelledTransfersRef.current.has(transferId)) {
                finish();
                return;
              }
            }

            const packet = new Uint8Array(36 + chunkBuffer.byteLength);
            packet.set(idBytes, 0);
            packet.set(new Uint8Array(chunkBuffer), 36);
            dc.send(packet.buffer);
          } else {
            // Fast native Base64 chunk for WebSocket relay
            const base64Data = await new Promise<string>((resBase64) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const result = reader.result as string;
                resBase64(result.split(',')[1] || '');
              };
              reader.readAsDataURL(new Blob([chunkBuffer]));
            });

            sendWsMessage({
              type: 'file:relay:chunk',
              fromId: selfInfoRef.current.id,
              targetId: targetPeerId,
              transferId,
              data: base64Data,
            });

            if (offset % (CHUNK_SIZE * 16) === 0) {
              await new Promise((r) => setTimeout(r, 2));
            }
          }

          offset += chunkBuffer.byteLength;

          const now = Date.now();
          const timeDiff = (now - lastTime) / 1000;
          if (timeDiff >= 0.2 || offset >= file.size) {
            const speed = timeDiff > 0 ? (offset - lastOffset) / timeDiff : 0;
            lastTime = now;
            lastOffset = offset;

            const progress = file.size > 0 ? Math.min(100, (offset / file.size) * 100) : 100;
            setTransfers((prev) =>
              prev.map((item) => {
                if (item.transferId === transferId) {
                  return {
                    ...item,
                    transferredBytes: offset,
                    progress,
                    speedBytesPerSec: speed > 0 ? speed : item.speedBytesPerSec,
                    mode,
                  };
                }
                return item;
              })
            );
          }
        }

        setTransfers((prev) =>
          prev.map((item) =>
            item.transferId === transferId
              ? {
                  ...item,
                  transferredBytes: file.size,
                  progress: 100,
                  status: 'completed',
                  endTime: Date.now(),
                }
              : item
          )
        );
        finish();
      };

      // 1. Direct High-Speed LAN Resumable Chunk Stream (Supports True Pause & Resume for huge files)
      const targetPeer = peers.find((p) => p.id === targetPeerId);
      const rawIp = targetPeer?.ip || (targetPeerId.startsWith('peer-') ? targetPeerId.replace('peer-', '').replace(/-/g, '.') : '');
      const cleanIp = (rawIp || '').trim().replace(/^https?:\/\//, '').replace(/:[0-9]+.*$/, '').trim();
      const isDirectLan = Boolean(cleanIp && cleanIp !== '127.0.0.1' && !cleanIp.includes('x') && !cleanIp.startsWith('169.254'));
      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      const canDirectHttp = !isHttps || cleanIp === window.location.hostname;
      const directApiBase = (isDirectLan && canDirectHttp) ? `http://${cleanIp}:3000` : '';

      const HTTP_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks (instant pause & high throughput)

      const streamOverDirectHttpChunked = async () => {
        let offset = 0;
        let lastSpeedTime = Date.now();
        let lastSpeedOffset = 0;

        while (offset < file.size) {
          if (cancelledTransfersRef.current.has(transferId)) {
            finish();
            return;
          }

          // True Pause handling: wait as long as isPausedRef is true
          while (isPausedRef.current) {
            if (cancelledTransfersRef.current.has(transferId)) {
              finish();
              return;
            }
            await new Promise((r) => setTimeout(r, 200));
            // Reset baseline so there is no false 10x speed burst when resumed
            lastSpeedTime = Date.now();
            lastSpeedOffset = offset;
          }

          const end = Math.min(offset + HTTP_CHUNK_SIZE, file.size);
          const chunkBlob = file.slice(offset, end);
          const isLastChunk = end >= file.size;

          let chunkSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (cancelledTransfersRef.current.has(transferId)) {
              finish();
              return;
            }
            try {
              const res = await fetch(`${directApiBase}/api/upload-chunk`, {
                method: 'POST',
                headers: {
                  'x-file-name': encodeURIComponent(filePath),
                  'x-target-path': encodeURIComponent(targetDrive),
                  'x-chunk-offset': offset.toString(),
                  'x-total-size': file.size.toString(),
                  'x-is-last-chunk': isLastChunk ? 'true' : 'false',
                  'x-transfer-id': transferId,
                  'x-sender-name': encodeURIComponent(selfInfoRef.current.name),
                },
                body: chunkBlob,
              });

              if (res.ok) {
                chunkSuccess = true;
                break;
              }
            } catch (retryErr) {
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 400 * attempt));
              }
            }
          }

          if (!chunkSuccess) {
            console.warn('[DirectUploadChunk] Direct chunk upload failed after 3 retries, falling back:', targetPeerId);
            streamOverDataChannelOrRelay();
            return;
          }

          offset = end;

          const now = Date.now();
          const timeDiff = (now - lastSpeedTime) / 1000;
          let speed = 0;
          if (timeDiff >= 0.25 || offset >= file.size) {
            speed = timeDiff > 0 ? (offset - lastSpeedOffset) / timeDiff : 0;
            lastSpeedTime = now;
            lastSpeedOffset = offset;
          }

          const progress = file.size > 0 ? Math.min(100, (offset / file.size) * 100) : 100;
          setTransfers((prev) =>
            prev.map((item) =>
              item.transferId === transferId
                ? {
                    ...item,
                    transferredBytes: offset,
                    progress,
                    speedBytesPerSec: speed > 0 ? speed : item.speedBytesPerSec,
                    mode: 'webrtc',
                  }
                : item
            )
          );

          // Synchronize real-time progress on recipient PC
          sendWsMessage({
            type: 'file:progress',
            targetId: targetPeerId,
            transferId,
            transferredBytes: offset,
            progress,
            speedBytesPerSec: speed,
          });
        }

        setTransfers((prev) =>
          prev.map((item) =>
            item.transferId === transferId
              ? {
                  ...item,
                  transferredBytes: file.size,
                  progress: 100,
                  status: 'completed',
                  endTime: Date.now(),
                }
              : item
          )
        );
        finish();
      };

      if (directApiBase) {
        streamOverDirectHttpChunked();
        return;
      }

      // 2. Fallback: WebRTC DataChannel or WebSocket Relay
      streamOverDataChannelOrRelay();
    });
  };

  // Recipient accepts incoming offer
  const handleAcceptOffer = (transferId: string, chosenDrive: string) => {
    if (!incomingOffer) return;
    const targetPeerId = incomingOffer.fromId;

    // Send response
    sendWsMessage({
      type: 'file:response',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      transferId,
      accepted: true,
      chosenDrive,
    });

    setIncomingOffer(null);

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId
          ? { ...item, status: 'transferring', targetDrive: chosenDrive }
          : item
      )
    );
  };

  // Recipient declines incoming offer
  const handleDeclineOffer = (transferId: string) => {
    if (!incomingOffer) return;
    const targetPeerId = incomingOffer.fromId;

    sendWsMessage({
      type: 'file:response',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      transferId,
      accepted: false,
      reason: 'Declined by recipient',
    });

    incomingBuffersRef.current.delete(transferId);
    setIncomingOffer(null);

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId ? { ...item, status: 'declined' } : item
      )
    );
  };

  // Cancel an ongoing transfer
  const handleCancelTransfer = (transferId: string) => {
    cancelledTransfersRef.current.add(transferId);
    sendQueueRef.current = sendQueueRef.current.filter((task) => task.transferId !== transferId);
    incomingBuffersRef.current.delete(transferId);
    pendingFilesRef.current.delete(transferId);

    const targetTransfer = transfers.find((t) => t.transferId === transferId);
    if (targetTransfer) {
      sendWsMessage({
        type: 'file:cancel',
        fromId: selfInfo.id,
        targetId: targetTransfer.peerId,
        transferId,
      });
    }

    setTransfers((prev) =>
      prev.map((item) =>
        item.transferId === transferId ? { ...item, status: 'cancelled' } : item
      )
    );
  };

  // Save received file
  const handleSaveToDisk = (item: TransferItem) => {
    if (!item.blobUrl) return;
    const a = document.createElement('a');
    a.href = item.blobUrl;
    a.download = item.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Remove item from transfers list
  const handleClearTransfer = (id: string) => {
    setTransfers((prev) => prev.filter((item) => item.id !== id));
  };

  // Request remote peer to open the folder on their PC
  const handleOpenRemoteFolder = useCallback((item: TransferItem) => {
    // 1. Send WebSocket signal to recipient PC
    sendWsMessage({
      type: 'open:folder:request',
      fromId: selfInfo.id,
      targetId: item.peerId,
      path: item.targetDrive,
    });

    // 2. Also try direct HTTP request if recipient IP is known
    const targetPeer = peers.find((p) => p.id === item.peerId);
    if (targetPeer?.ip && !targetPeer.ip.includes('x') && targetPeer.ip !== '127.0.0.1') {
      fetch(`http://${targetPeer.ip}:3000/api/open-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.targetDrive || 'Downloads' }),
      }).catch(() => {});
    }
  }, [peers, selfInfo.id, sendWsMessage]);

  // Send quick text
  const handleSendText = (text: string, targetPeerId?: string) => {
    sendWsMessage({
      type: 'clipboard:send',
      fromId: selfInfo.id,
      targetId: targetPeerId,
      text,
    });

    setSharedTexts((prev) => [
      {
        id: generateId(),
        fromId: selfInfo.id,
        fromName: selfInfo.name,
        text,
        timestamp: Date.now(),
        isSelf: true,
      },
      ...prev.slice(0, 50),
    ]);
  };

  // Update profile
  const handleUpdateName = (newName: string) => {
    setSelfInfo((prev) => ({ ...prev, name: newName }));
    localStorage.setItem('lan_device_name', newName);
    sendWsMessage({
      type: 'update:profile',
      name: newName,
    });
  };

  const handleUpdateDeviceType = (newType: 'desktop' | 'laptop' | 'mobile') => {
    setSelfInfo((prev) => ({ ...prev, deviceType: newType }));
    localStorage.setItem('lan_device_type', newType);
  };

  const handleUpdateNetworkTag = (newTag: string) => {
    setSelfInfo((prev) => ({ ...prev, networkTag: newTag }));
    localStorage.setItem('lan_network_tag', newTag);
    sendWsMessage({
      type: 'update:profile',
      networkTag: newTag,
    });
  };

  const handleSwitchRoom = (newRoomId: string) => {
    setCurrentRoomId(newRoomId);
    setPeers([]);
    sendWsMessage({
      type: 'switch:room',
      newRoomId,
    });
  };

  // Global Drag & Drop Handler with counter and auto-reset
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const resetDrag = () => {
      dragCounterRef.current = 0;
      setIsGlobalDragging(false);
    };

    const handleWindowDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.types?.includes('Files')) {
        dragCounterRef.current++;
        if (dragCounterRef.current === 1) {
          setIsGlobalDragging(true);
        }
      }
    };

    const handleWindowDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        resetDrag();
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      e.preventDefault();
      resetDrag();
      if (e.dataTransfer) {
        const filesArray = await extractFilesFromDataTransfer(e.dataTransfer);
        if (filesArray.length > 0) {
          if (peers.length > 0) {
            const targetIds = selectedPeerId ? [selectedPeerId] : [peers[0].id];
            const dest = activeTargetPathRef.current || 'Desktop';
            handleSendFiles(filesArray, targetIds, 'Any Drive', dest);
          } else {
            setSelectedFiles((prev) => [...prev, ...filesArray]);
          }
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        resetDrag();
      }
    };

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('dragend', resetDrag);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', resetDrag);
    document.body.addEventListener('mouseleave', resetDrag);

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('dragend', resetDrag);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', resetDrag);
      document.body.removeEventListener('mouseleave', resetDrag);
    };
  }, [peers, selectedPeerId]);

  const handleConnectToPeer = (peerId: string) => {
    setConnectingPeerId(peerId);
    const peer = peers.find((p) => p.id === peerId);

    setPairedPeerId(peerId);
    setSelectedPeerId(peerId);
    playCompletionChime();

    // Send pairing request directly through our stable WebSocket signaling channel
    sendWsMessage({
      type: 'pair:request',
      fromId: selfInfo.id,
      targetId: peerId,
      autoAccept: true,
    });

    rtcManagerRef.current?.initiateConnection(peerId);

    // If peer has an external IP on LAN, also notify via direct HTTP without tearing down WebSocket
    if (peer && peer.ip && peer.ip !== selfInfo.ip && !peer.ip.startsWith('127.') && !peer.ip.includes('x')) {
      const targetHost = `${peer.ip}:3000`;
      fetch(`http://${targetHost}/api/direct-connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: selfInfoRef.current }),
        signal: AbortSignal.timeout(1000),
      }).catch(() => {});
    }

    setTimeout(() => {
      setConnectingPeerId(null);
    }, 800);
  };

  const handleDisconnectPeer = (peerId: string) => {
    const peerToDisconnect = peers.find((p) => p.id === peerId);
    const remoteIp = peerToDisconnect?.ip || peerId.replace(/^peer-/, '').replace(/-/g, '.');

    setPairedPeerId(null);
    setSelectedPeerId(null);
    setConnectingPeerId(null);

    // 1. Notify via WebSocket to local mesh and paired client
    sendWsMessage({
      type: 'pair:disconnect',
      fromId: selfInfo.id,
      targetId: peerId,
    });

    // 2. Direct HTTP notification to remote PC's server so it disconnects simultaneously
    if (remoteIp && remoteIp !== selfInfo.ip && !remoteIp.startsWith('127.') && !remoteIp.includes('x')) {
      fetch(`http://${remoteIp}:3000/api/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromId: selfInfo.id, targetId: peerId }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
    }

    // 3. Clean up WebRTC peer connection
    rtcManagerRef.current?.cleanupPeer(peerId);
  };

  const handleRefreshScan = async () => {
    setIsScanning(true);

    // Clear stale ghost peers before starting a fresh genuine scan (keep active paired peer if any)
    setPeers((prev) => (pairedPeerId ? prev.filter((p) => p.id === pairedPeerId) : []));

    sendWsMessage({ type: 'scan:request' });

    // Active LAN subnet scan
    const currentIp =
      networkInfo?.localIps?.find(
        (net) =>
          net.address.startsWith('192.168.') ||
          net.address.startsWith('10.') ||
          net.address.startsWith('172.')
      )?.address ||
      selfInfo.ip ||
      networkInfo?.localIps?.[0]?.address;

    if (currentIp && currentIp.includes('.')) {
      const parts = currentIp.split('.');
      if (parts.length === 4) {
        const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const myLastOctet = parseInt(parts[3], 10);

        // Helper to probe a single IP and only add if it's an authentic external live PC
        const probeAndAddPeer = async (probeIp: string) => {
          // Strictly exclude self IP, loopback, or already scanned self machine
          if (
            probeIp === currentIp ||
            probeIp === selfInfo.ip ||
            probeIp.startsWith('127.')
          ) {
            return;
          }

          try {
            const res = await fetch(`http://${probeIp}:3000/api/network-info`, {
              signal: AbortSignal.timeout(400),
            });
            if (res.ok) {
              const info = await res.json();

              // Confirm it's not the same machine (hostname and IP match check)
              if (
                info.hostname &&
                networkInfo?.hostname &&
                info.hostname === networkInfo.hostname &&
                info.localIps?.some((net: any) => net.address === currentIp)
              ) {
                return;
              }

              const discoveredPeer: PeerInfo = {
                id: `peer-${probeIp.replace(/\./g, '-')}`,
                name: info.hostname ? `${info.hostname}` : `Windows PC (${probeIp})`,
                deviceType: 'desktop',
                os: 'Windows',
                networkTag: 'Wi-Fi LAN',
                targetDrives:
                  info.drives && info.drives.length > 0
                    ? info.drives
                    : ['Desktop', 'C:\\ (System Disk)', 'D:\\ (Data / Files)', 'Downloads'],
                roomId: 'local-mesh',
                ip: probeIp,
                joinedAt: Date.now(),
              };

              // Display authentic active peer
              setPeers((prev) => {
                const withoutThis = prev.filter((p) => p.ip !== probeIp && p.id !== discoveredPeer.id);
                return [...withoutThis, discoveredPeer];
              });
            }
          } catch {}
        };

        // Probe immediate neighbors (-25 to +25) and standard router DHCP ranges
        const targetOctets = new Set<number>();
        for (let offset = -25; offset <= 25; offset++) {
          const oct = myLastOctet + offset;
          if (oct >= 2 && oct <= 254 && oct !== myLastOctet) {
            targetOctets.add(oct);
          }
        }
        for (let i = 2; i <= 35; i++) {
          if (i !== myLastOctet) targetOctets.add(i);
        }
        for (let i = 100; i <= 130; i++) {
          if (i !== myLastOctet) targetOctets.add(i);
        }
        for (let i = 180; i <= 215; i++) {
          if (i !== myLastOctet) targetOctets.add(i);
        }

        const octetList = Array.from(targetOctets);
        const batchSize = 40;

        for (let b = 0; b < octetList.length; b += batchSize) {
          const batch = octetList.slice(b, b + batchSize);
          await Promise.allSettled(
            batch.map((oct) => probeAndAddPeer(`${subnet}.${oct}`))
          );
        }
      }
    }

    setIsScanning(false);
  };

  // Scanning runs strictly upon user manual click (Refresh Scan button) per user requirement

  const handleConnectByIp = async (rawIp: string): Promise<boolean> => {
    const cleanIp = rawIp
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/:[0-9]+.*$/, '')
      .trim()
      .toLowerCase();

    if (!cleanIp) return false;

    // 1. Check if any connected peer has this IP or matching name
    const foundPeer = peers.find((p) => {
      const pIp = (p.ip || '').toLowerCase();
      return (
        pIp === cleanIp ||
        pIp.includes(cleanIp) ||
        cleanIp.includes(pIp) ||
        p.name.toLowerCase().includes(cleanIp)
      );
    });

    if (foundPeer) {
      handleConnectToPeer(foundPeer.id);
      return true;
    }

    const targetHost = `${cleanIp}:3000`;

    // 2. Direct HTTP probe to the other PC's API
    try {
      let peerInfoFromRemote: any = null;
      try {
        const netRes = await fetch(`http://${targetHost}/api/network-info`, {
          signal: AbortSignal.timeout(2500),
        });
        if (netRes.ok) {
          peerInfoFromRemote = await netRes.json();
        }
      } catch {}

      const postRes = await fetch(`http://${targetHost}/api/direct-connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer: selfInfoRef.current }),
        signal: AbortSignal.timeout(2500),
      }).catch(() => null);

      if (peerInfoFromRemote || (postRes && postRes.ok)) {
        const postData = postRes && postRes.ok ? await postRes.json() : {};
        const remotePeers: PeerInfo[] = postData.peers || [];
        const remoteTarget: PeerInfo =
          remotePeers.find((p) => p.id !== selfInfo.id) ||
          remotePeers[0] || {
            id: `peer-${cleanIp.replace(/\./g, '-')}`,
            name: peerInfoFromRemote?.hostname ? `${peerInfoFromRemote.hostname}` : `Windows PC (${cleanIp})`,
            deviceType: 'desktop',
            os: 'Windows',
            networkTag: 'Wi-Fi LAN',
            roomId: 'local-mesh',
            ip: cleanIp,
            targetDrives: (peerInfoFromRemote?.drives && peerInfoFromRemote.drives.length > 0)
              ? peerInfoFromRemote.drives
              : ['C:\\ (System Disk)', 'D:\\ (Data / Files)', 'Downloads'],
            joinedAt: Date.now(),
          };

        setPeers((prev) => {
          const filtered = prev.filter((p) => p.id !== remoteTarget.id && p.ip !== cleanIp);
          return [...filtered, remoteTarget];
        });

        setPairedPeerId(remoteTarget.id);
        setSelectedPeerId(remoteTarget.id);

        // Request pairing directly through the active WebSocket channel without disconnecting
        sendWsMessage({
          type: 'pair:request',
          fromId: selfInfo.id,
          targetId: remoteTarget.id,
          autoAccept: true,
        });
        rtcManagerRef.current?.initiateConnection(remoteTarget.id);
        playCompletionChime();
        return true;
      }
    } catch (err) {
      console.warn('Direct HTTP connect attempt failed:', err);
    }

    // 3. Fallback: Direct WebSocket connection to remote PC
    try {
      const testWs = new WebSocket(`ws://${targetHost}/ws`);
      const wsConnectPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          try { testWs.close(); } catch {}
          resolve(false);
        }, 3000);

        testWs.onopen = () => {
          clearTimeout(timeout);
          try { testWs.close(); } catch {}

          const syntheticTargetId = `peer-${cleanIp.replace(/\./g, '-')}`;
          const syntheticPeer: PeerInfo = {
            id: syntheticTargetId,
            name: `Windows PC (${cleanIp})`,
            deviceType: 'desktop',
            os: 'Windows',
            networkTag: 'Wi-Fi LAN',
            roomId: 'local-mesh',
            ip: cleanIp,
            joinedAt: Date.now(),
          };

          setPeers((prev) => {
            const filtered = prev.filter((p) => p.ip !== cleanIp && p.id !== syntheticTargetId);
            return [...filtered, syntheticPeer];
          });
          setPairedPeerId(syntheticTargetId);
          setSelectedPeerId(syntheticTargetId);
          playCompletionChime();
          resolve(true);
        };

        testWs.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      });

      const wsOk = await wsConnectPromise;
      if (wsOk) return true;
    } catch {}

    // 4. Also ask local server in case remote peer connected to us
    sendWsMessage({
      type: 'pair:by-ip',
      fromId: selfInfo.id,
      targetIp: cleanIp,
    });

    return false;
  };

  const pairedPeer = peers.find((p) => p.id === pairedPeerId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Top Header */}
      <Header
        lang={lang}
        onToggleLang={() => setLang((prev) => (prev === 'bn' ? 'en' : 'bn'))}
        onlineCount={peers.length + 1}
        isConnected={isConnected}
        pairedPeerName={pairedPeer?.name}
        onOpenNetworkModal={() => setIsNetworkModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Direct IP Connect Bar (Paste this PC's IP or another PC's IP) */}
        <DirectIpConnectBar
          myIp={selfInfo.ip || networkInfo?.localIps?.[0]?.address || '192.168.1.x'}
          networkInfo={networkInfo}
          pairedPeer={pairedPeer || null}
          onConnectByIp={handleConnectByIp}
          lang={lang}
        />

        {/* Mobile-Style Wi-Fi PC Scanner Hub (Search, Scan, Select & Green Connected Status) */}
        <WifiScannerHub
          peers={peers}
          pairedPeerId={pairedPeerId}
          connectingPeerId={connectingPeerId}
          onConnectToPeer={handleConnectToPeer}
          onDisconnectPeer={handleDisconnectPeer}
          onRefreshScan={handleRefreshScan}
          isScanning={isScanning}
          lang={lang}
          onOpenConnectModal={() => setIsNetworkModalOpen(true)}
        />

        {/* Main Drag & Drop Zone */}
        <DropZone
          peers={peers}
          selectedPeerId={pairedPeerId || selectedPeerId}
          onSelectPeer={(id) => {
            setSelectedPeerId(id);
            if (id) setPairedPeerId(id);
          }}
          onSendFiles={handleSendFiles}
          onTargetPathChange={(path) => {
            activeTargetPathRef.current = path;
          }}
          onDragEndOrDrop={() => {
            dragCounterRef.current = 0;
            setIsGlobalDragging(false);
          }}
          selectedFiles={selectedFiles}
          setSelectedFiles={setSelectedFiles}
          lang={lang}
        />

        {/* Active Transfers & Live Speed Section */}
        {transfers.length > 0 && (() => {
          const totalCount = transfers.length;
          const completedCount = transfers.filter((t) => t.status === 'completed').length;
          const inProgressCount = transfers.filter(
            (t) => t.status === 'transferring' || t.status === 'waiting_approval' || t.status === 'queued' || t.status === 'paused'
          ).length;
          const totalBytes = transfers.reduce((acc, t) => acc + (t.fileSize || 0), 0);
          const transferredBytes = transfers.reduce(
            (acc, t) => acc + (t.status === 'completed' ? (t.fileSize || 0) : (t.transferredBytes || 0)),
            0
          );
          const overallPercent =
            totalBytes > 0
              ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
              : totalCount > 0
              ? Math.round((completedCount / totalCount) * 100)
              : 0;
          const totalSpeed = transfers.reduce(
            (acc, t) => acc + (t.status === 'transferring' ? (t.speedBytesPerSec || 0) : 0),
            0
          );
          const currentTransferRate = Math.max(totalSpeed, liveBatchSpeed);

          return (
            <div className="space-y-3">
              {/* Overall Batch Progress Banner */}
              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-xl space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isPaused ? (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1.5">
                        <Pause className="w-3.5 h-3.5" />
                        <span>{lang === 'bn' ? 'ফাইল ট্রান্সফার পজ করা আছে' : 'Transfer Paused'}</span>
                      </span>
                    ) : inProgressCount > 0 ? (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 flex items-center gap-1.5 animate-pulse">
                        <Zap className="w-3.5 h-3.5" />
                        <span>{lang === 'bn' ? 'ফাইল ট্রান্সফার চলমান...' : 'Transfer in progress...'}</span>
                      </span>
                    ) : completedCount === totalCount ? (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{lang === 'bn' ? 'সকল ফাইল সফলভাবে ট্রান্সফার সম্পন্ন' : 'All files transferred'}</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                        <span>{lang === 'bn' ? 'ট্রান্সফার সারাংশ' : 'Transfer Summary'}</span>
                      </span>
                    )}

                    {(inProgressCount > 0 || isPaused) && (
                      <button
                        type="button"
                        onClick={togglePauseResume}
                        className={`px-3 py-1 text-xs font-semibold rounded-md border transition-all flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95 ${
                          isPaused
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-500 shadow-emerald-950/40'
                            : 'bg-amber-600 hover:bg-amber-500 text-white border-amber-500 shadow-amber-950/40'
                        }`}
                        title={
                          isPaused
                            ? (lang === 'bn' ? 'ট্রান্সফার পুনরায় চালু করুন' : 'Resume Transfer')
                            : (lang === 'bn' ? 'ট্রান্সফার সাময়িকভাবে থামিয়ে রাখুন' : 'Pause Transfer')
                        }
                      >
                        {isPaused ? (
                          <>
                            <Play className="w-3.5 h-3.5 fill-current" />
                            <span>{lang === 'bn' ? 'রিজিউম (Resume)' : 'Resume'}</span>
                          </>
                        ) : (
                          <>
                            <Pause className="w-3.5 h-3.5 fill-current" />
                            <span>{lang === 'bn' ? 'পজ (Pause)' : 'Pause'}</span>
                          </>
                        )}
                      </button>
                    )}

                    <span className="text-xs text-slate-200 font-medium">
                      {lang === 'bn'
                        ? `মোট ${totalCount}টি ফাইলের মধ্যে ${completedCount}টি সম্পন্ন (${totalCount - completedCount}টি বাকি)`
                        : `${completedCount} of ${totalCount} files completed (${totalCount - completedCount} remaining)`}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs">
                    {/* Live Transfer Rate (Always visible in the marked location) */}
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-950/70 border border-indigo-500/40 text-indigo-300 font-mono text-xs shadow-sm">
                      <Zap className={`w-3.5 h-3.5 text-indigo-400 shrink-0 ${inProgressCount > 0 ? 'animate-pulse' : ''}`} />
                      <span className="text-[11px] font-sans text-slate-400">{lang === 'bn' ? 'স্পিড:' : 'Speed:'}</span>
                      <span className="font-bold text-indigo-200 tabular-nums">
                        {formatSpeed(currentTransferRate)}
                      </span>
                    </div>

                    <span className="font-mono text-slate-400">
                      {formatBytes(transferredBytes)} / {formatBytes(totalBytes)}
                    </span>
                    <span className="font-mono text-base font-bold text-emerald-400">
                      {overallPercent}%
                    </span>
                  </div>
                </div>

                {/* Overall Progress Bar */}
                <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden border border-slate-800 p-0.5">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${
                      completedCount === totalCount
                        ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50'
                        : 'bg-gradient-to-r from-indigo-500 via-indigo-400 to-emerald-400 shadow-sm shadow-indigo-500/50'
                    }`}
                    style={{ width: `${overallPercent}%` }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <span>{t.activeTransfers}</span>
                  <span className="text-xs font-mono font-normal text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded-full">
                    {transfers.length}
                  </span>
                </h3>
                <button
                  onClick={() =>
                    setTransfers((prev) =>
                      prev.filter((t) => t.status === 'transferring' || t.status === 'waiting_approval' || t.status === 'paused' || t.status === 'queued')
                    )
                  }
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
                >
                  {lang === 'bn' ? 'সম্পন্নগুলো মুছুন' : 'Clear completed'}
                </button>
              </div>

              <div className="space-y-3">
                {transfers.map((item) => (
                  <TransferItemCard
                    key={item.id}
                    item={item}
                    lang={lang}
                    onCancel={handleCancelTransfer}
                    onSaveToDisk={handleSaveToDisk}
                    onClear={handleClearTransfer}
                    onOpenRemoteFolder={handleOpenRemoteFolder}
                  />
                ))}
              </div>
            </div>
          );
        })()}

      </main>

      {/* Global Drag & Drop Overlay */}
      {isGlobalDragging && (
        <div
          onClick={() => {
            dragCounterRef.current = 0;
            setIsGlobalDragging(false);
          }}
          className="fixed inset-0 z-50 bg-indigo-950/85 backdrop-blur-md border-4 border-dashed border-indigo-400 flex flex-col items-center justify-center text-white space-y-4 cursor-pointer animate-in fade-in duration-100 select-none"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dragCounterRef.current = 0;
              setIsGlobalDragging(false);
            }}
            className="absolute top-6 right-6 px-4 py-2 bg-slate-800/90 hover:bg-slate-700 text-white rounded-xl border border-slate-600 text-xs font-semibold flex items-center gap-1.5 shadow-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
            <span>{lang === 'bn' ? 'বন্ধ করুন (বাতিল)' : 'Close (Cancel)'}</span>
          </button>
          <div className="w-20 h-20 rounded-3xl bg-indigo-600 flex items-center justify-center shadow-2xl shadow-indigo-600/50 animate-bounce pointer-events-none">
            <UploadCloud className="w-10 h-10" />
          </div>
          <div className="text-center space-y-1.5 pointer-events-none">
            <h2 className="text-2xl font-bold tracking-tight">
              {lang === 'bn' ? 'যেকোনো স্থানে ফাইল ড্রপ করুন!' : 'Drop Files Anywhere to Transfer!'}
            </h2>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs font-mono">
              <HardDrive className="w-3.5 h-3.5" />
              <span>
                {lang === 'bn' ? 'নির্বাচিত গন্তব্য: ' : 'Target Folder: '}
                {activeTargetPathRef.current || 'Desktop'}
              </span>
            </div>
            <p className="text-xs text-indigo-300/80 pt-1">
              {lang === 'bn'
                ? '(স্ক্রিন বন্ধ করতে যেকোনো জায়গায় ক্লিক করুন বা Esc চাপুন)'
                : '(Click anywhere or press Esc to dismiss)'}
            </p>
          </div>
        </div>
      )}

      {/* Modals */}
      <IncomingTransferModal
        offer={incomingOffer}
        lang={lang}
        onAccept={handleAcceptOffer}
        onDecline={handleDeclineOffer}
      />

      <NetworkInfoModal
        isOpen={isNetworkModalOpen}
        onClose={() => setIsNetworkModalOpen(false)}
        lang={lang}
        networkInfo={networkInfo}
        currentRoomId={currentRoomId}
        onSwitchRoom={handleSwitchRoom}
      />

      {/* Footer */}
      <footer className="mt-12 py-6 border-t border-slate-800 text-center text-xs text-slate-500">
        <p>
          Wi-Fi LAN File Drop · {lang === 'bn' ? 'লোকাল ওয়াইফাই ও ল্যান ফাইল ট্রান্সফার' : 'Direct LAN & Wi-Fi P2P Transfer'} · 100% Local & Fast
        </p>
      </footer>
    </div>
  );
}

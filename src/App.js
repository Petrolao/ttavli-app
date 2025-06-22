import React, { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signInAnonymously, signOut, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, onSnapshot } from 'firebase/firestore';
// Import Tone.js for sound effects.
// Corrected import: explicitly import NoiseSynth, PluckSynth, and other Tone.js modules.
import { NoiseSynth, PluckSynth, context as ToneContext, start as ToneStart } from 'tone';

// Tailwind CSS is assumed to be available in the environment via a global CDN.

// --- Firebase Configuration and Initialization ---
// Retrieve Firebase configuration and app ID from the environment.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Declare Firebase instances globally so they are initialized once.
let app;
let db;
let auth;

try {
  // Initialize Firebase only if the configuration is provided.
  if (Object.keys(firebaseConfig).length > 0) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    console.log("Firebase initialized successfully.");
  } else {
    // Log a warning if Firebase config is missing, indicating demo mode.
    console.warn("Firebase config not found. Running in demo mode without persistence.");
  }
} catch (error) {
  // Catch and log any errors during Firebase initialization.
  // Ignore "already exists" errors, which can occur during hot reloading.
  console.error("Firebase initialization error at global scope:", error);
  if (!error.message.includes("already exists")) {
    console.error("Failed to initialize Firebase:", error);
  }
}

// --- Auth Context for User Management ---
// Create a React context to make authentication state and functions available throughout the app.
const AuthContext = createContext(null);

const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null); // Stores Firebase user object
  const [userId, setUserId] = useState(null);           // Stores the user's UID or a generated ID for anonymous users
  const [loadingAuth, setLoadingAuth] = useState(true); // Indicates if authentication state is still being determined

  useEffect(() => {
    // If Firebase Auth is not initialized, stop loading and return.
    if (!auth) {
      console.warn("Auth object is undefined, skipping auth listener setup.");
      setLoadingAuth(false);
      return;
    }

    console.log("Setting up onAuthStateChanged listener...");
    // Subscribe to Firebase authentication state changes.
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      console.log("onAuthStateChanged triggered. User:", user ? user.uid : 'null');
      if (user) {
        // If a user is logged in (or anonymously authenticated)
        setCurrentUser(user);
        setUserId(user.uid);
        if (db) { // Ensure Firestore is initialized before interacting with it.
          const userRef = doc(db, 'artifacts', appId, 'users', user.uid);
          try {
            // Check if user profile exists in Firestore and create if not.
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists()) {
              await setDoc(userRef, {
                displayName: user.displayName || 'Anonymous User',
                email: user.email || '',
                photoURL: user.photoURL || '',
                createdAt: new Date(),
                totalGamesPlayed: 0,
                totalMatchesWon: 0,
                totalGamesWon: 0,
                totalGamesLost: 0,
                winLossRatio: 0,
              });
              console.log("New user profile created or existing updated.");
            }
          } catch (firestoreError) {
            console.error("Error accessing user document in Firestore:", firestoreError);
          }
        }
      } else {
        // If no user is logged in, attempt anonymous sign-in or use custom token.
        setCurrentUser(null);
        setUserId(null);
        console.log("User logged out or anonymous.");
        if (auth && typeof __initial_auth_token !== 'undefined') {
          try {
            // Attempt to sign in with a provided custom token.
            await signInWithCustomToken(auth, __initial_auth_token);
            console.log("Signed in with custom token.");
          } catch (error) {
            console.error("Error signing in with custom token:", error);
            try {
              // Fallback to anonymous sign-in if custom token fails.
              await signInAnonymously(auth);
              console.log("Signed in anonymously after custom token error.");
            } catch (anonError) {
              console.error("Error signing in anonymously:", anonError);
            }
          }
        } else if (auth) {
          try {
            // If no custom token, sign in anonymously.
            await signInAnonymously(auth);
            console.log("Signed in anonymously.");
          } catch (anonError) {
            console.error("Error signing in anonymously:", anonError);
          }
        }
      }
      setLoadingAuth(false); // Authentication loading is complete.
      console.log("Auth loading finished.");
    });

    // Cleanup function for the effect: unsubscribe from auth state changes.
    return () => {
      console.log("Cleaning up onAuthStateChanged listener.");
      unsubscribe();
    };
  }, [appId]); // Re-run effect only if appId changes.

  // Function to sign in with Google.
  const signInWithGoogle = async () => {
    if (!auth) {
      console.error("Firebase Auth not initialized. Cannot sign in.");
      return;
    }
    const provider = new GoogleAuthProvider();
    try {
      console.log("Attempting Google sign-in popup...");
      await signInWithPopup(auth, provider);
      console.log("Google sign-in successful.");
    } catch (error) {
      console.error("Error signing in with Google:", error);
    }
  };

  // Function to log out the current user.
  const logout = async () => {
    if (auth) {
      try {
        console.log("Attempting to log out...");
        await signOut(auth);
        console.log("User logged out successfully.");
      } catch (error) {
        console.error("Error signing out:", error);
      }
    }
  };

  // Provide auth state and functions to children components.
  return (
    <AuthContext.Provider value={{ currentUser, userId, loadingAuth, signInWithGoogle, logout, db, appId }}>
      {children}
    </AuthContext.Provider>
  );
};

// --- Firestore Service for Data Operations ---
// Centralized service for interacting with Firestore.
const FirestoreService = {
  // Saves a match result to a public collection in Firestore.
  saveMatchResult: async (matchData) => {
    if (!db) {
      console.warn("Firestore not initialized. Cannot save match result.");
      return;
    }
    try {
      const matchesCollectionRef = collection(db, 'artifacts', appId, 'public', 'data', 'matches');
      await setDoc(doc(matchesCollectionRef), {
        ...matchData,
        timestamp: new Date(),
      });
      console.log("Match result saved successfully.");
    } catch (error) {
      console.error("Error saving match result:", error);
    }
  },

  // Updates a user's statistics in their private Firestore document.
  updateUserStats: async (userId, statsUpdate) => {
    if (!db || !userId) {
      console.warn("Firestore not initialized or userId missing. Cannot update user stats.");
      return;
    }
    try {
      const userRef = doc(db, 'artifacts', appId, 'users', userId);
      await updateDoc(userRef, statsUpdate);
      console.log(`User ${userId} stats updated.`);
    } catch (error) {
      console.error("Error updating user stats:", error);
    }
  },

  // Fetches all user profiles in real-time using a snapshot listener.
  getUsers: (callback) => {
    if (!db) {
      console.warn("Firestore not initialized. Cannot get users.");
      return () => {}; // Return a no-op unsubscribe function if db isn't ready.
    }
    console.log("Attempting to fetch users. Current Auth User ID:", auth?.currentUser?.uid);
    const usersCollectionRef = collection(db, 'artifacts', appId, 'users');
    const q = query(usersCollectionRef);
    // onSnapshot provides real-time updates.
    return onSnapshot(q, (snapshot) => {
      const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      console.log("Users fetched:", users.length, "users.");
      callback(users);
    }, (error) => {
      console.error("Error fetching users:", error);
    });
  }
};

// --- Game Components ---

// Dice Component: Displays dice values and a roll button with animation and sound integration.
const Dice = ({ dice, setDice, rollDice, disabled, soundEnabled }) => {
  const [isRolling, setIsRolling] = useState(false);
  const rollEventSynthRef = useRef(null); // Ref for the main "clattering" sound
  const impactSynthRef = useRef(null); // Ref for the final "thud" impact

  useEffect(() => {
    // Initialize main rolling sound synth
    if (!rollEventSynthRef.current) {
        rollEventSynthRef.current = new NoiseSynth({ // Use NoiseSynth directly
            noise: {
                type: 'brown' // Brown noise for a lower frequency, rumbling sound
            },
            envelope: {
                attack: 0.005,
                decay: 0.1,
                sustain: 0,
                release: 0.15,
                releaseCurve: 'linear'
            },
            volume: -20 // Start with a lower volume
        }).toDestination();
    }

    // Initialize impact sound synth (short, sharp click/thud)
    if (!impactSynthRef.current) {
        impactSynthRef.current = new PluckSynth({ // Use PluckSynth directly
            attackNoise: 1, // High attack noise for a percussive feel
            dampening: 2000,
            resonance: 0.7
        }).toDestination();
        impactSynthRef.current.volume.value = -10; // Louder for impact
    }

    // Clean up synths on unmount
    return () => {
      if (rollEventSynthRef.current) {
        rollEventSynthRef.current.dispose();
        rollEventSynthRef.current = null;
      }
      if (impactSynthRef.current) {
        impactSynthRef.current.dispose();
        impactSynthRef.current = null;
      }
    };
  }, []);

  // Function to play a more realistic dice roll sound using Tone.js
  const playDiceRollSound = async (duration = 0.8) => { // Increased duration for more rolling feel
    if (!soundEnabled) return;

    if (ToneContext.state !== 'running') { // Use ToneContext
      try {
        await ToneStart(); // Use ToneStart
        console.log("Tone.js context started successfully for dice sound.");
      } catch (error) {
        console.error("Error starting Tone.js context for dice sound:", error);
        return;
      }
    }

    // Always use ToneContext.currentTime for scheduling to prevent negative time errors.
    const start = ToneContext.currentTime; // Use ToneContext
    const end = start + duration;

    // Main rolling sound: bursts of noise
    rollEventSynthRef.current.triggerAttack(start); // Start noise immediately
    rollEventSynthRef.current.triggerRelease(end - 0.1); // Release just before end for tail

    // Schedule multiple small, quick impacts during the roll
    const numHits = 10 + Math.floor(Math.random() * 10); // Randomize number of hits
    for (let i = 0; i < numHits; i++) {
        // Schedule within the roll duration, ensuring strictly increasing times
        const scheduledTime = start + (i / numHits) * (duration - 0.1) + (Math.random() * 0.02); // Small random jitter
        const freq = 100 + Math.random() * 200; // Vary frequency for each hit
        impactSynthRef.current.triggerAttackRelease(freq, "32n", scheduledTime, 0.5 + Math.random() * 0.5);
    }

    // Final impact sound at the very end
    impactSynthRef.current.triggerAttackRelease("C3", "16n", end - 0.05, 0.8); // Stronger, lower frequency impact

  };

  const handleRollDice = async () => {
    if (disabled || isRolling) return;

    setIsRolling(true);
    playDiceRollSound(0.8); // Play the enhanced dice roll sound with a duration

    // Simulate rolling animation by rapidly changing dice numbers
    let rollCount = 0;
    const maxRolls = 15; // Increased rolls for longer animation
    const rollInterval = 50; // Shorter interval for faster animation
    let finalDie1, finalDie2; // Variables to store the final dice values

    const animateRoll = setInterval(() => {
        if (rollCount < maxRolls) {
            setDice([
                Math.floor(Math.random() * 6) + 1,
                Math.floor(Math.random() * 6) + 1
            ]);
            rollCount++;
        } else {
            clearInterval(animateRoll);
            setIsRolling(false);
            // Generate the final dice values after animation
            finalDie1 = Math.floor(Math.random() * 6) + 1;
            finalDie2 = Math.floor(Math.random() * 6) + 1;
            setDice([finalDie1, finalDie2]); // Ensure the displayed dice match the final values
            rollDice(finalDie1, finalDie2); // Pass final values to the game logic
        }
    }, rollInterval);
  };

  return (
    <div className="flex flex-col items-center p-4 bg-gray-100 rounded-lg shadow-inner">
      <h3 className="text-xl font-bold text-gray-800 mb-3">Dice</h3>
      {/* Dice display removed from here to be moved onto the board */}
      <button
        onClick={handleRollDice}
        disabled={disabled || isRolling}
        className={`px-6 py-2 rounded-full font-semibold shadow-md transition-all duration-200 ${
          disabled || isRolling ? 'bg-gray-300 text-gray-600 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white transform hover:scale-105'
        }`}
      >
        {isRolling ? 'Rolling...' : 'Roll Dice'}
      </button>
    </div>
  );
};

// Backgammon Board Component: Renders the SVG-based backgammon board.
const BackgammonBoard = ({ board, currentPlayer, onPointClick, selectedPoint, possibleMovePoints, currentDiceValues }) => {
  // Define constants for board dimensions and checker size.
  const pointHeight = 250;
  const checkerRadius = 15;
  const boardWidth = 720;
  const boardHeight = 500;
  const barWidth = 60;
  const bearOffAreaWidth = 40; // Width of the new bear-off areas

  // Define mapping for each point on the board to its visual position.
  const visualPointMapping = [
    // Top-left quadrant (points 13-18, visually from left to right)
    { gamePoint: 13, isTop: true, indexInHalf: 0, colorOffset: 0 },
    { gamePoint: 14, isTop: true, indexInHalf: 1, colorOffset: 1 },
    { gamePoint: 15, isTop: true, indexInHalf: 2, colorOffset: 0 },
    { gamePoint: 16, isTop: true, indexInHalf: 3, colorOffset: 1 },
    { gamePoint: 17, isTop: true, indexInHalf: 4, colorOffset: 0 },
    { gamePoint: 18, isTop: true, indexInHalf: 5, colorOffset: 1 },
    // Top-right quadrant (points 19-24, visually from left to right)
    { gamePoint: 19, isTop: true, indexInHalf: 6, colorOffset: 0 },
    { gamePoint: 20, isTop: true, indexInHalf: 7, colorOffset: 1 },
    { gamePoint: 21, isTop: true, indexInHalf: 8, colorOffset: 0 },
    { gamePoint: 22, isTop: true, indexInHalf: 9, colorOffset: 1 },
    { gamePoint: 23, isTop: true, indexInHalf: 10, colorOffset: 0 },
    { gamePoint: 24, isTop: true, indexInHalf: 11, colorOffset: 1 },

    // Bottom-left quadrant (points 12-7, visually from right to left)
    { gamePoint: 12, isTop: false, indexInHalf: 0, colorOffset: 0 },
    { gamePoint: 11, isTop: false, indexInHalf: 1, colorOffset: 1 },
    { gamePoint: 10, isTop: false, indexInHalf: 2, colorOffset: 0 },
    { gamePoint: 9, isTop: false, indexInHalf: 3, colorOffset: 1 },
    { gamePoint: 8, isTop: false, indexInHalf: 4, colorOffset: 0 },
    { gamePoint: 7, isTop: false, indexInHalf: 5, colorOffset: 1 },
    // Bottom-right quadrant (points 6-1, visually from right to left)
    { gamePoint: 6, isTop: false, indexInHalf: 6, colorOffset: 0 },
    { gamePoint: 5, isTop: false, indexInHalf: 7, colorOffset: 1 },
    { gamePoint: 4, isTop: false, indexInHalf: 8, colorOffset: 0 },
    { gamePoint: 3, isTop: false, indexInHalf: 9, colorOffset: 1 },
    { gamePoint: 2, isTop: false, indexInHalf: 10, colorOffset: 0 },
    { gamePoint: 1, isTop: false, indexInHalf: 11, colorOffset: 1 },
  ];

  const halfBoardSectionWidth = boardWidth / 2;
  const pointWidth = halfBoardSectionWidth / 6;

  // Define board colors for SVG elements.
  const boardBgColor = '#654321'; // Darker brown for main board
  const pointColor1 = '#A0522D'; // Sienna
  const pointColor2 = '#D2B48C'; // Tan (lighter brown)
  // Replaced solid colors with patterns for leather texture
  const barFill = "url(#darkLeatherTexture)";
  const bearOffFill = "url(#darkLeatherTexture)";

  return (
    <div className="relative w-full aspect-[1.8/1] bg-brown-900 rounded-lg shadow-2xl overflow-hidden border-8 border-brown-950">
      <svg
        viewBox={`0 0 ${boardWidth + barWidth + (bearOffAreaWidth * 2)} ${boardHeight}`} // Adjust viewBox for new areas
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {/* White Marble Pattern */}
          <linearGradient id="whiteMarbleGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f0f0f0" />
            <stop offset="50%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#e0e0e0" />
          </linearGradient>
          <filter id="whiteMarbleTexture" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.1" numOctaves="2" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
            <feComposite operator="in" in="SourceGraphic" in2="noise" /> {/* Apply noise as a subtle overlay */}
          </filter>

          {/* Black Marble Pattern */}
          <linearGradient id="blackMarbleGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#202020" />
            <stop offset="50%" stopColor="#000000" />
            <stop offset="100%" stopColor="#303030" />
          </linearGradient>
          <filter id="blackMarbleTexture" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.1" numOctaves="2" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
            <feComposite operator="in" in="SourceGraphic" in2="noise" />
          </filter>

          {/* Dark Leather Texture Pattern for Bar and Bear-off Areas */}
          <pattern id="darkLeatherTexture" patternUnits="userSpaceOnUse" width="20" height="20">
              <rect x="0" y="0" width="20" height="20" fill="#3A2A1A"/> {/* Dark base color */}
              <circle cx="5" cy="5" r="2" fill="#4B3A2A" opacity="0.5"/>
              <circle cx="15" cy="15" r="2" fill="#4B3A2A" opacity="0.5"/>
              <rect x="0" y="10" width="20" height="1" fill="#2B1A0A" opacity="0.3"/>
          </pattern>
        </defs>

        {/* Board Background, shifted right to accommodate left bear-off area */}
        <rect x={bearOffAreaWidth} y="0" width={boardWidth + barWidth} height={boardHeight} fill={boardBgColor} />

        {/* Bear-off areas (holders) */}
        {/* Left bear-off area (for white checkers borne off) */}
        <rect
          x="0" y="0" width={bearOffAreaWidth} height={boardHeight}
          fill={bearOffFill} stroke="#3d2812" strokeWidth="2"
          onClick={() => onPointClick(0)} // Point 0 for white's bear-off area
          className={possibleMovePoints.includes(0) && currentPlayer === 'white' ? 'stroke-lime-500 stroke-4 cursor-pointer' : ''}
        />
        {/* Right bear-off area (for black checkers borne off) */}
        <rect
          x={boardWidth + barWidth + bearOffAreaWidth} y="0" width={bearOffAreaWidth} height={boardHeight}
          fill={bearOffFill} stroke="#3d2812" strokeWidth="2"
          onClick={() => onPointClick(25)} // Point 25 for black's bear-off area
          className={possibleMovePoints.includes(25) && currentPlayer === 'black' ? 'stroke-lime-500 stroke-4 cursor-pointer' : ''}
        />


        {/* Bar in the middle of the board, shifted right */}
        <rect x={halfBoardSectionWidth + bearOffAreaWidth} y="0" width={barWidth} height={boardHeight} fill={barFill} stroke="#3d2812" strokeWidth="2" />

        {/* Render points (triangles), shifted right */}
        {visualPointMapping.map((pointData) => {
          const { gamePoint, isTop, indexInHalf } = pointData;
          const fillColor = (indexInHalf % 2 === 0) ? pointColor1 : pointColor2; // Alternate point colors.

          let currentPointX;
          // Calculate X position based on which half of the board the point is in.
          if (indexInHalf < 6) { // First half of either top or bottom row.
              currentPointX = pointWidth * indexInHalf + bearOffAreaWidth; // Shift by bear-off area width
          } else { // Second half, after the bar.
              currentPointX = pointWidth * indexInHalf + barWidth + bearOffAreaWidth; // Shift by bar and bear-off area width
          }

          // Define triangle points for top or bottom row.
          const trianglePoints = isTop
              ? `${currentPointX},0 ${currentPointX + pointWidth / 2},${pointHeight} ${currentPointX + pointWidth},0`
              : `${currentPointX},${boardHeight} ${currentPointX + pointWidth / 2},${boardHeight - pointHeight} ${currentPointX + pointWidth},${boardHeight}`;

          const isSelected = selectedPoint === gamePoint;
          const isPossibleMove = possibleMovePoints.includes(gamePoint);

          return (
            <g key={gamePoint}>
              <polygon
                points={trianglePoints}
                fill={fillColor}
                stroke={isPossibleMove ? 'lime' : (isSelected ? 'yellow' : '#333')} // Highlight selected/possible moves.
                strokeWidth={isPossibleMove || isSelected ? '4' : '1'}
                className="hover:opacity-80 transition-opacity cursor-pointer"
                onClick={() => onPointClick(gamePoint)} // Make the point itself clickable
              />
              {/* Render small black arrow for possible moves */}
              {isPossibleMove && gamePoint !== 0 && ( // Don't show arrow for bear-off (point 0)
                <polygon
                  points={
                    isTop
                      ? `${currentPointX + pointWidth / 2 - 8},${28} ${currentPointX + pointWidth / 2 + 8},${28} ${currentPointX + pointWidth / 2},${12}` // Upward arrow (towards top edge)
                      : `${currentPointX + pointWidth / 2 - 8},${boardHeight - 28} ${currentPointX + pointWidth / 2 + 8},${boardHeight - 28} ${currentPointX + pointWidth / 2},${boardHeight - 12}` // Downward arrow (towards bottom edge)
                  }
                  fill="black"
                  stroke="white" // Small white border for visibility
                  strokeWidth="1"
                  opacity="0.8"
                />
              )}
              {/* Render checkers on each point */}
              {board.points[gamePoint - 1].checkers.map((color, checkerIdx) => {
                let checkerY;
                const checkerCountOnPoint = board.points[gamePoint - 1].checkers.length;
                // Calculate Y position for checkers, stacking them.
                if (isTop) {
                    checkerY = (checkerIdx * checkerRadius * 2) + checkerRadius;
                } else {
                    checkerY = boardHeight - checkerRadius - (checkerIdx * checkerRadius * 2);
                }

                // Limit visible checkers to 5 and show count for more.
                if (checkerIdx >= 5) {
                    if (checkerIdx === 5) {
                        return (
                            <text
                                key={`count-${gamePoint}`}
                                x={currentPointX + pointWidth / 2}
                                y={isTop ? (checkerRadius * 2 * 5) + checkerRadius + 10 : boardHeight - (checkerRadius * 2 * 5) - checkerRadius - 10}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="white"
                                fontSize="18"
                                fontWeight="bold"
                            >
                                x{checkerCountOnPoint}
                            </text>
                        );
                    }
                    return null;
                }

                // Add highlighting for the current player's checkers
                const isCurrentPlayerChecker = color === currentPlayer;
                // Highlight color and width: black for white player, white for black player, yellow if selected
                const checkerStrokeColor = isCurrentPlayerChecker
                    ? (isSelected ? 'yellow' : (currentPlayer === 'white' ? 'black' : 'white'))
                    : '#555';
                const checkerStrokeWidth = isCurrentPlayerChecker ? (isSelected ? '3' : '3') : '1'; // Thicker border for current player

                const checkerFill = color === 'white' ? 'url(#whiteMarbleGradient)' : 'url(#blackMarbleGradient)';
                const checkerFilter = color === 'white' ? 'url(#whiteMarbleTexture)' : 'url(#blackMarbleTexture)';


                return (
                  <circle
                    key={`${gamePoint}-${checkerIdx}`}
                    cx={currentPointX + pointWidth / 2}
                    cy={checkerY}
                    r={checkerRadius}
                    fill={checkerFill} // Use the gradient for fill
                    filter={checkerFilter} // Apply the filter for texture
                    stroke={checkerStrokeColor}
                    strokeWidth={checkerStrokeWidth}
                    className="cursor-pointer" // Make checkers look clickable
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent clicking through to the point if checker is clicked
                        onPointClick(gamePoint);
                    }}
                  />
                );
              })}
            </g>
          );
        })}

        {/* Render checkers on the bar */}
        {board.bar.white > 0 && (
          <g>
            {Array(Math.min(board.bar.white, 5)).fill(0).map((_, idx) => (
              <circle
                key={`bar-white-${idx}`}
                cx={halfBoardSectionWidth + barWidth / 2 + bearOffAreaWidth} // Shifted by bear-off area width
                cy={boardHeight / 2 - checkerRadius - (idx * checkerRadius * 2)}
                r={checkerRadius}
                fill="url(#whiteMarbleGradient)" // Use the gradient
                filter="url(#whiteMarbleTexture)" // Apply the filter
                stroke={currentPlayer === 'white' ? 'black' : '#555'} // Highlight if white's turn with black border
                strokeWidth={currentPlayer === 'white' ? '3' : '1'} // Thicker for current player
              />
            ))}
            {board.bar.white > 5 && (
                 <text
                    x={halfBoardSectionWidth + barWidth / 2 + bearOffAreaWidth}
                    y={boardHeight / 2 - checkerRadius - (checkerRadius * 2 * 5) - 10}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="white"
                    fontSize="18"
                    fontWeight="bold"
                >
                    x{board.bar.white}
                </text>
            )}
          </g>
        )}
        {board.bar.black > 0 && (
          <g>
            {Array(Math.min(board.bar.black, 5)).fill(0).map((_, idx) => (
              <circle
                key={`bar-black-${idx}`}
                cx={halfBoardSectionWidth + barWidth / 2 + bearOffAreaWidth} // Shifted by bear-off area width
                cy={boardHeight / 2 + checkerRadius + (idx * checkerRadius * 2)}
                r={checkerRadius}
                fill="url(#blackMarbleGradient)" // Use the gradient
                filter="url(#blackMarbleTexture)" // Apply the filter
                stroke={currentPlayer === 'black' ? 'white' : '#555'} // Highlight if black's turn with white border
                strokeWidth={currentPlayer === 'black' ? '3' : '1'} // Thicker for current player
              />
            ))}
            {board.bar.black > 5 && (
                 <text
                    x={halfBoardSectionWidth + barWidth / 2 + bearOffAreaWidth}
                    y={boardHeight / 2 + checkerRadius + (checkerRadius * 2 * 5) + 10}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="black"
                    fontSize="18"
                    fontWeight="bold"
                >
                    x{board.bar.black}
                </text>
            )}
          </g>
        )}

        {/* Render borne-off checkers in their dedicated areas */}
        {board.home.white > 0 && (
            <g>
                {Array(board.home.white).fill(0).map((_, idx) => (
                    <circle
                        key={`home-white-${idx}`}
                        cx={bearOffAreaWidth / 2}
                        cy={boardHeight - checkerRadius - (idx * checkerRadius * 2) - 5} // Stack from bottom up
                        r={checkerRadius}
                        fill="url(#whiteMarbleGradient)"
                        filter="url(#whiteMarbleTexture)"
                        stroke="#555"
                        strokeWidth="1"
                    />
                ))}
            </g>
        )}
        {board.home.black > 0 && (
            <g>
                {Array(board.home.black).fill(0).map((_, idx) => (
                    <circle
                        key={`home-black-${idx}`}
                        cx={boardWidth + barWidth + bearOffAreaWidth + (bearOffAreaWidth / 2)}
                        cy={checkerRadius + (idx * checkerRadius * 2) + 5} // Stack from top down
                        r={checkerRadius}
                        fill="url(#blackMarbleGradient)"
                        filter="url(#blackMarbleTexture)"
                        stroke="#555"
                        strokeWidth="1"
                    />
                ))}
            </g>
        )}

         {/* Player Turn Indicator */}
         <text
            x={boardWidth / 2 + barWidth / 2 + bearOffAreaWidth} // Center horizontally, accounting for bear-off area
            y={boardHeight / 2 - 55} // Shifted further up to make more space for dice
            textAnchor="middle"
            dominantBaseline="middle" // Ensures true vertical centering
            fill={currentPlayer === 'white' ? 'white' : 'black'}
            stroke={currentPlayer === 'white' ? 'black' : 'white'} // Added outline
            strokeWidth="1.5" // Outline thickness
            fontSize="24"
            fontWeight="bold"
            className="transition-all duration-500"
         >
            {currentPlayer === 'white' ? 'White\'s Turn' : 'Black\'s Turn'}
         </text>

         {/* Display Current Dice Values on the Board */}
         <g>
            <rect
                x={halfBoardSectionWidth + bearOffAreaWidth + barWidth / 2 - 45} // Position left die, centered with 10px gap
                y={boardHeight / 2 + 5}
                width="40"
                height="40"
                fill="white"
                stroke="#333"
                strokeWidth="1"
                rx="5" ry="5" // Rounded corners
            />
            <text
                x={halfBoardSectionWidth + bearOffAreaWidth + barWidth / 2 - 25} // Text for left die
                y={boardHeight / 2 + 30}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="black"
                fontSize="24"
                fontWeight="bold"
            >
                {currentDiceValues[0] || '?'}
            </text>

            <rect
                x={halfBoardSectionWidth + bearOffAreaWidth + barWidth / 2 + 5} // Position right die, centered with 10px gap
                y={boardHeight / 2 + 5}
                width="40"
                height="40"
                fill="white"
                stroke="#333"
                strokeWidth="1"
                rx="5" ry="5" // Rounded corners
            />
            <text
                x={halfBoardSectionWidth + bearOffAreaWidth + barWidth / 2 + 25} // Text for right die
                y={boardHeight / 2 + 30}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="black"
                fontSize="24"
                fontWeight="bold"
            >
                {currentDiceValues[1] || '?'}
            </text>
         </g>


         {/* Render point numbers ON TOP (moved from inside visualPointMapping loop) */}
        <g className="point-numbers-overlay">
            {visualPointMapping.map((pointData) => {
                const { gamePoint, isTop, indexInHalf } = pointData;
                let currentPointX;
                if (indexInHalf < 6) {
                    currentPointX = pointWidth * indexInHalf + bearOffAreaWidth;
                } else {
                    currentPointX = pointWidth * indexInHalf + barWidth + bearOffAreaWidth;
                }
                return (
                    <text
                        key={`num-${gamePoint}`}
                        x={currentPointX + pointWidth / 2}
                        y={isTop ? pointHeight + 25 : boardHeight - pointHeight - 15}
                        textAnchor="middle"
                        dominantBaseline={isTop ? "hanging" : "ideographic"}
                        fill="white"
                        stroke="black"
                        strokeWidth="1"
                        fontSize="18"
                        fontWeight="bold"
                    >
                        {gamePoint}
                    </text>
                );
            })}
        </g>
      </svg>
    </div>
  );
};

// Custom Confirmation Modal Component: Replaces native window.confirm.
const ConfirmModal = ({ message, onConfirm, onCancel }) => {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg p-8 shadow-2xl text-center max-w-sm w-full border-t-8 border-blue-600">
                <h3 className="text-xl font-bold text-gray-800 mb-4">Confirmation</h3>
                <p className="text-lg text-gray-700 mb-6">{message}</p>
                <div className="flex justify-center gap-4">
                    <button
                        onClick={onConfirm}
                        className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded-full shadow-md transition-all duration-300 transform hover:scale-105"
                    >
                        Yes
                    </button>
                    <button
                        onClick={onCancel}
                        className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-full shadow-md transition-all duration-300 transform hover:scale-105"
                    >
                        No
                    </button>
                </div>
            </div>
        </div>
    );
};

// --- Main Game Logic Component (BackgammonGame) ---
const BackgammonGame = ({ onMatchEnd }) => {
  const { currentUser, userId } = useContext(AuthContext);
  const [matchFormat, setMatchFormat] = useState(7); // Number of games in a match (e.g., best of 7)
  const [playerScore, setPlayerScore] = useState(0);    // Current player's score in the match
  const [opponentScore, setOpponentScore] = useState(0); // Opponent's score in the match
  const [gameMessage, setGameMessage] = useState("Click 'Start Match' to begin!"); // Messages for user guidance
  const [isPlaying, setIsPlaying] = useState(false);     // Game active state
  const [showModal, setShowModal] = useState(false);     // State for general info modal (e.g., match end)
  const [modalMessage, setModalMessage] = useState('');   // Message for the general info modal
  const [showConfirmModal, setShowConfirmModal] = useState(false); // State for custom confirmation modal
  const [confirmModalAction, setConfirmModalAction] = useState(null); // Action to run if confirmation is given

  const [dice, setDice] = useState([0, 0]);             // Current dice roll values
  const [availableDice, setAvailableDice] = useState([]); // Dice values that can still be used for moves
  const [currentPlayer, setCurrentPlayer] = useState('white'); // 'white' or 'black' player turn
  const [selectedPoint, setSelectedPoint] = useState(null); // The board point (1-24) from which a checker is selected
  // Change possibleMovePoints to store objects with targetPoint and diceUsed
  const [possibleMovesInfo, setPossibleMovesInfo] = useState([]); // Array of { targetPoint, diceUsed[] }
  const [mustReenterFromBar, setMustReenterFromBar] = useState(false); // Flag if player has checkers on the bar
  const [soundEnabled, setSoundEnabled] = useState(true); // State for toggling dice sound
  const [moveHistory, setMoveHistory] = useState([]); // Stores history of individual checker moves

  // Define the custom paths for movement as per user's description
  const whitePath = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13];
  const blackPath = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];


  // Board State: Represents the checkers on each point, bar, and home areas.
  const [boardState, setBoardState] = useState({
    points: Array(24).fill(null).map(() => ({ checkers: [] })),
    bar: { white: 0, black: 0 },
    home: { white: 0, black: 0 },
  });

  // Initializes the board to the standard starting positions.
  const initializeBoard = useCallback(() => {
    const newPoints = Array(24).fill(null).map(() => ({ checkers: [] }));

    // White player's initial positions as per user's latest precise description
    newPoints[11].checkers = Array(2).fill('white');  // Point 12 (index 11)
    newPoints[19].checkers = Array(3).fill('white');  // Point 20 (index 19)
    newPoints[0].checkers = Array(5).fill('white');   // Point 1 (index 0)
    newPoints[17].checkers = Array(5).fill('white');  // Point 18 (index 17)

    // Black player's initial positions as per user's latest precise description
    newPoints[6].checkers = Array(5).fill('black');   // Point 7 (index 6)
    newPoints[4].checkers = Array(3).fill('black');   // Point 5 (index 4)
    newPoints[23].checkers = Array(5).fill('black');  // Point 24 (index 23)
    newPoints[12].checkers = Array(2).fill('black');  // Point 13 (index 12)

    setBoardState({ points: newPoints, bar: { white: 0, black: 0 }, home: { white: 0, black: 0 } });
  }, []);

  // Helper to determine the opponent's color.
  const getOpponentColor = useCallback((playerColor) => (playerColor === 'white' ? 'black' : 'opponent'), []);

  // Determines if a point is blocked by the opponent (2 or more opponent checkers).
  const isPointBlocked = useCallback((pointIndex, playerColor, currentBoardState = boardState) => {
    const point = currentBoardState.points[pointIndex];
    if (!point || point.checkers.length === 0) return false; // Point is empty or no checkers.
    const opponentColor = getOpponentColor(playerColor);
    return point.checkers[0] === opponentColor && point.checkers.length >= 2;
  }, [getOpponentColor, boardState]);

  // Checks if all of a player's checkers are in their home board.
  const areAllCheckersInHomeBoard = useCallback((playerColor, currentBoardState = boardState) => {
    const totalCheckers = 15;
    let checkersBorneOff = currentBoardState.home[playerColor];
    let checkersInHomeQuadrantOnBoard = 0;

    const isWhite = playerColor === 'white';
    // The home points are the last 6 points in their respective paths
    // For white, these are [6, 5, 4, 3, 2, 1]
    // For black, these are [19, 20, 21, 22, 23, 24]
    const homePointsForBearingOff = isWhite ? [6, 5, 4, 3, 2, 1] : [19, 20, 21, 22, 23, 24];

    // If checkers are on the bar, they are not yet in the home board, so bearing off is not possible.
    if (currentBoardState.bar[playerColor] > 0) {
        return false;
    }

    // Iterate through all 24 board points
    for (let i = 0; i < 24; i++) {
        const gamePoint = i + 1;
        const checkersOnCurrentPoint = currentBoardState.points[i].checkers.filter(c => c === playerColor).length;

        if (checkersOnCurrentPoint > 0) {
            // If any checker of the current player is on a point *not* in their home bearing-off region,
            // then not all checkers are in the home board.
            if (!homePointsForBearingOff.includes(gamePoint)) {
                return false;
            } else {
                checkersInHomeQuadrantOnBoard += checkersOnCurrentPoint;
            }
        }
    }

    // All checkers are considered "home" if total checkers (borne off + on home board points) equals 15.
    return (checkersBorneOff + checkersInHomeQuadrantOnBoard) === totalCheckers;
  }, [boardState]); // Removed whitePath, blackPath from here as homePointsForBearingOff is hardcoded

  // Helper function to check if any moves are possible with given state and dice
  const checkIfAnyPossibleMoves = useCallback((currentBoardState, player, currentDice) => {
    const isWhite = player === 'white';
    const playerPath = isWhite ? whitePath : blackPath; // Accessing whitePath, blackPath from outer scope

    // Check for bar re-entry moves first
    if (currentBoardState.bar[player] > 0) {
        for (const die of currentDice) {
            let targetGamePoint;
            if (isWhite) {
                targetGamePoint = die;      // White re-enters on points 1-6
            } else {
                targetGamePoint = 18 + die; // Black re-enters on points 19-24
            }
            const targetPointIndex = targetGamePoint - 1;
            if (targetPointIndex >= 0 && targetPointIndex < 24 && !isPointBlocked(targetPointIndex, player, currentBoardState)) {
                return true; // Found a possible bar re-entry move
            }
        }
        return false; // No possible bar re-entry moves
    }

    // If no checkers on bar, check for moves from the board
    for (let i = 0; i < 24; i++) {
        const currentPointCheckers = currentBoardState.points[i].checkers;
        if (currentPointCheckers.length > 0 && currentPointCheckers[0] === player) {
            const fromPoint = i + 1;
            const fromPointIndexInPath = playerPath.indexOf(fromPoint);
            if (fromPointIndexInPath === -1) {
                continue; // This checker is not on the player's active path (shouldn't happen with correct setup)
            }

            for (const die of currentDice) {
                let targetPathIndex = fromPointIndexInPath + die;

                if (targetPathIndex >= playerPath.length) { // Potential bearing off
                    if (areAllCheckersInHomeBoard(player, currentBoardState)) {
                        let noCheckersEarlierInPath = true;
                        // Check if any checkers are on a point further away than 'fromPoint' in the bearing off quadrant
                        const homePoints = isWhite ? [6, 5, 4, 3, 2, 1] : [19, 20, 21, 22, 23, 24];
                        const fromPointHomeIndex = homePoints.indexOf(fromPoint); // Index within home points (0-5)
                        if (fromPointHomeIndex !== -1) { // Only check if current checker is in home board
                            for (let k = 0; k < fromPointHomeIndex; k++) { // Check points "closer" to bearing off
                                const furtherPointOnBoard = homePoints[k]; // These are points with higher value for white, lower for black
                                if (currentBoardState.points[furtherPointOnBoard - 1].checkers.includes(player)) {
                                    noCheckersEarlierInPath = false; // Found a checker further away (i.e. "earlier" in path)
                                    break;
                                }
                            }
                        } else {
                            noCheckersEarlierInPath = false; // Checker is not even in home board, so can't bear off
                        }

                        // Special rule: if die is exact match for point OR die is larger than any point in home board
                        // AND all other checkers are on points closer to bear-off
                        const dieCanOvershoot = die >= (isWhite ? fromPoint : (25 - fromPoint));

                        if (noCheckersEarlierInPath) {
                             // If die exactly matches the point, or it overshoots and this is the highest point
                            if ( (isWhite && fromPoint === die) || (!isWhite && (25 - fromPoint) === die) ) {
                                return true; // Exact bear off
                            }
                            // Overshoot rule: if die is larger than current point AND this is the furthest checker
                            if (dieCanOvershoot) {
                                let isFurthestChecker = true;
                                for (let k = 0; k < 24; k++) {
                                    if (currentBoardState.points[k].checkers.includes(player)) {
                                        if (isWhite && k + 1 > fromPoint) { // White: if a checker is on a point higher than 'fromPoint'
                                            isFurthestChecker = false;
                                            break;
                                        }
                                        if (!isWhite && k + 1 < fromPoint) { // Black: if a checker is on a point lower than 'fromPoint'
                                            isFurthestChecker = false;
                                            break;
                                        }
                                    }
                                }
                                if (isFurthestChecker) {
                                    return true; // Overshoot bear off
                                }
                            }
                        }
                    }
                } else { // Regular move on board
                    const targetGamePoint = playerPath[targetPathIndex];
                    if (targetGamePoint >= 1 && targetGamePoint <= 24) {
                        if (!isPointBlocked(targetGamePoint - 1, player, currentBoardState)) {
                            return true; // Found a possible regular move
                        }
                    }
                }
            }
        }
    }
    return false; // No possible moves found
  }, [isPointBlocked, areAllCheckersInHomeBoard, whitePath, blackPath]); // Added dependencies

  // Calculates all possible moves for a checker from a given `fromPoint` with `currentDice`.
  // Returns an array of objects: { targetPoint: number, diceUsed: number[] }
  const calculatePossibleMoves = useCallback((fromPoint, currentDice, playerColor, board) => {
      const moves = []; // Will store objects: { targetPoint, diceUsed[] }
      const isWhite = playerColor === 'white';
      const playerPath = isWhite ? whitePath : blackPath;

      // Helper for single step move validation and target determination
      const checkSingleStepLogic = (startPoint, startPathIndex, die, tempBoard, playerColor, isInitialFromBar = false) => {
          let targetGamePoint = null; // Default to null for invalid/no move
          let isValid = false;
          let isBearingOff = false;

          // If moving from bar, target calculation is direct based on die roll
          if (isInitialFromBar && startPoint === 'bar') {
              if (isWhite) {
                  targetGamePoint = die; // White re-enters on points 1-6
              } else {
                  targetGamePoint = 18 + die; // Black re-enters on points 19-24
              }
              const targetPointIndex = targetGamePoint - 1;
              if (targetPointIndex >= 0 && targetPointIndex < 24 && !isPointBlocked(targetPointIndex, playerColor, tempBoard)) {
                  isValid = true;
              }
              return { targetGamePoint, isValid, isBearingOff: false };
          }

          // If moving from board point
          const targetPathIndex = startPathIndex + die;

          if (targetPathIndex >= playerPath.length) { // Potential bearing off
              isBearingOff = true;
              if (areAllCheckersInHomeBoard(playerColor, tempBoard)) {
                  // Check overshoot rule: no checkers should be on points further away from the bear-off area
                  let noCheckersFurtherAway = true;
                  const homePoints = isWhite ? [6, 5, 4, 3, 2, 1] : [19, 20, 21, 22, 23, 24];
                  const fromPointHomeIndex = homePoints.indexOf(startPoint);

                  if (fromPointHomeIndex !== -1) {
                      for (let i = 0; i < fromPointHomeIndex; i++) { // Check points "further" in the path (closer to start of home board)
                          const furtherPoint = homePoints[i];
                          if (tempBoard.points[furtherPoint - 1].checkers.includes(playerColor)) {
                              noCheckersFurtherAway = false;
                              break;
                          }
                      }
                  } else {
                      // Checker is not in the home board at all, so cannot bear off
                      noCheckersFurtherAway = false;
                  }

                  if (noCheckersFurtherAway) {
                       // If die matches the point exactly or is greater than the distance to bear off (overshoot)
                       const distanceToBearOff = isWhite ? startPoint : (25 - startPoint); // How many pips needed to bear off this checker
                       if (die === distanceToBearOff || (die > distanceToBearOff && noCheckersFurtherAway)) {
                           targetGamePoint = isWhite ? 0 : 25; // Special value for white/black bear-off
                           isValid = true;
                       }
                  }
              }
          } else { // Regular move on board
              const actualTargetGamePoint = playerPath[targetPathIndex];
              if (actualTargetGamePoint >= 1 && actualTargetGamePoint <= 24) {
                  if (!isPointBlocked(actualTargetGamePoint - 1, playerColor, tempBoard)) {
                      targetGamePoint = actualTargetGamePoint;
                      isValid = true;
                  }
              }
          }
          return { targetGamePoint, isValid, isBearingOff };
      };

      // 1. Bar re-entry moves (if applicable)
      if (mustReenterFromBar && fromPoint === 'bar') {
          currentDice.forEach(die => {
              const { targetGamePoint, isValid } = checkSingleStepLogic('bar', -1, die, board, playerColor, true); // -1 for path index as it's from bar
              if (isValid) {
                  moves.push({ targetPoint: targetGamePoint, diceUsed: [die] });
              }
          });
          // After considering bar re-entry, no other moves are possible from the board
          // So, if we are in mustReenterFromBar state and selected point is 'bar', return these moves.
          return moves;
      }

      // If not from bar, ensure fromPoint is a valid board point and has current player's checker
      if (fromPoint === 'bar' || !board.points[fromPoint - 1] || board.points[fromPoint - 1].checkers[0] !== playerColor) {
        return []; // Invalid starting point for a board move
      }

      const fromPointIndexInPath = playerPath.indexOf(fromPoint);
      if (fromPointIndexInPath === -1) {
          return []; // Should not happen for a valid checker on the board
      }

      // Recursive helper to find all possible move combinations
      const findAllMoves = (currentFromPoint, currentFromPathIndex, remainingDice, currentBoard, pathDice) => {
          if (remainingDice.length === 0) {
              return; // No more dice to use
          }

          const uniqueDiceConsidered = new Set();
          // Sort remaining dice to ensure consistent ordering for unique path generation
          const sortedRemainingDice = [...remainingDice].sort((a,b) => a-b);

          sortedRemainingDice.forEach((d1, originalIdx) => {
              // Create a temporary array to simulate removing this specific die instance
              const tempRemainingDice = [...sortedRemainingDice];
              const actualIdx = tempRemainingDice.indexOf(d1); // Find index of the first occurrence of this die
              if (actualIdx > -1) {
                tempRemainingDice.splice(actualIdx, 1);
              } else {
                  return; // Should not happen
              }

              const tempBoardAfterD1 = JSON.parse(JSON.stringify(currentBoard));
              let checkerSuccessfullyMovedInTemp = true;

              // Hypothetically remove checker from source point for the first step
              if (currentFromPoint === 'bar') {
                  if (tempBoardAfterD1.bar[playerColor] === 0) { checkerSuccessfullyMovedInTemp = false; }
                  else { tempBoardAfterD1.bar[playerColor]--; }
              } else {
                  if (!tempBoardAfterD1.points[currentFromPoint - 1] || tempBoardAfterD1.points[currentFromPoint - 1].checkers.length === 0 || tempBoardAfterD1.points[currentFromPoint - 1].checkers[0] !== playerColor) {
                      checkerSuccessfullyMovedInTemp = false;
                  } else {
                      tempBoardAfterD1.points[currentFromPoint - 1].checkers.pop();
                  }
              }

              if (!checkerSuccessfullyMovedInTemp) return;

              const { targetGamePoint: intermediatePoint, isValid: isValidIntermediate, isBearingOff: isIntermedBearOff } =
                  checkSingleStepLogic(currentFromPoint, currentFromPathIndex, d1, tempBoardAfterD1, playerColor);

              if (isValidIntermediate) {
                  if (!isIntermedBearOff) { // If not bearing off in intermediate step
                      if (tempBoardAfterD1.points[intermediatePoint - 1].checkers.length === 1 && tempBoardAfterD1.points[intermediatePoint - 1].checkers[0] === getOpponentColor(playerColor)) {
                          tempBoardAfterD1.points[intermediatePoint - 1].checkers.pop();
                          tempBoardAfterD1.bar[getOpponentColor(playerColor)]++;
                      }
                      // Check for block *after* hitting blot (if it's not a blot, it's just a regular move onto an empty or friendly point)
                      if (isPointBlocked(intermediatePoint - 1, playerColor, tempBoardAfterD1)) {
                          return; // This intermediate point is blocked, so this path is invalid.
                      }
                      tempBoardAfterD1.points[intermediatePoint - 1].checkers.push(playerColor);
                  }

                  const currentPathDice = [...pathDice, d1];
                  moves.push({ targetPoint: intermediatePoint, diceUsed: currentPathDice.sort((a,b)=>a-b) });

                  // Recurse with remaining dice from the intermediate point
                  const intermediatePointPathIndex = isIntermedBearOff ? playerPath.length : playerPath.indexOf(intermediatePoint);
                  if (intermediatePointPathIndex !== -1 && tempRemainingDice.length > 0) {
                      findAllMoves(intermediatePoint, intermediatePointPathIndex, tempRemainingDice, tempBoardAfterD1, currentPathDice);
                  }
              }
          });
      };

      findAllMoves(fromPoint, fromPointIndexInPath, currentDice, board, []);

      // Filter for unique target points and prioritize paths with fewer dice or higher sum
      const uniqueMovesMap = new Map(); // targetPoint -> { targetPoint, diceUsed }
      moves.forEach(move => {
          const key = move.targetPoint; // Using target point as the unique key
          // Create a canonical representation of diceUsed for comparison (sorted string)
          const currentDiceUsedStr = move.diceUsed.sort((a, b) => a - b).join(',');

          if (!uniqueMovesMap.has(key)) {
              uniqueMovesMap.set(key, move);
          } else {
              const existingMove = uniqueMovesMap.get(key);
              const existingDiceUsedStr = existingMove.diceUsed.sort((a, b) => a - b).join(',');

              // If the dice used are different for the same target, add it as a separate option
              if (currentDiceUsedStr !== existingDiceUsedStr) {
                  // This scenario means we might have two paths to the same point with different dice combos.
                  // For now, we'll keep the one that was added first, or apply a specific priority.
                  // Current implementation prioritizes earlier found moves if key exists,
                  // or if it's strictly better (fewer dice or higher sum for same # dice).
                  if (move.diceUsed.length < existingMove.diceUsed.length) {
                      uniqueMovesMap.set(key, move);
                  } else if (move.diceUsed.length === existingMove.diceUsed.length) {
                      const sumCurrent = move.diceUsed.reduce((sum, d) => sum + d, 0);
                      const sumExisting = existingMove.diceUsed.reduce((sum, d) => sum + d, 0);
                      if (sumCurrent > sumExisting) {
                          uniqueMovesMap.set(key, move);
                      }
                  }
              }
              // If diceUsed is the same, no need to add duplicate.
          }
      });


      return Array.from(uniqueMovesMap.values()); // Return objects with target and dice used.
  }, [mustReenterFromBar, areAllCheckersInHomeBoard, isPointBlocked, whitePath, blackPath, getOpponentColor]);

  // Ends the entire match and updates user statistics in Firebase.
  const endMatch = useCallback((playerWon) => {
    setIsPlaying(false);
    const winnerGames = playerWon ? playerScore : opponentScore;
    const loserGames = playerWon ? opponentScore : playerScore;

    setModalMessage(`Match Over! You ${playerWon ? 'won' : 'lost'} the best of ${matchFormat} match (${winnerGames}-${loserGames}).`);
    setShowModal(true);

    if (currentUser && !currentUser.isAnonymous) {
      // Prepare match result data for saving.
      const matchResult = {
        player1Id: userId,
        player1DisplayName: currentUser.displayName || 'You',
        player2Id: 'AI_Opponent', // Assuming single-player vs AI.
        player2DisplayName: 'AI Opponent',
        winnerId: playerWon ? userId : 'AI_Opponent',
        loserId: playerWon ? 'AI_Opponent' : userId,
        matchFormat: matchFormat,
        player1GamesWon: playerScore,
        player2GamesWon: opponentScore,
      };

      FirestoreService.saveMatchResult(matchResult); // Save match to Firestore.

      // Prepare user statistics update.
      const userStatsUpdate = {
        totalGamesPlayed: (currentUser.totalGamesPlayed || 0) + 1, // Count matches as "games played" for overall stats.
        totalMatchesWon: (currentUser.totalMatchesWon || 0) + (playerWon ? 1 : 0),
        totalMatchesLost: (currentUser.totalMatchesLost || 0) + (playerWon ? 0 : 1),
        totalGamesWon: (currentUser.totalGamesWon || 0) + playerScore, // Total games won across all matches.
        totalGamesLost: (currentUser.totalGamesLost || 0) + opponentScore, // Total games lost across all matches.
      };
      const newTotalMatches = userStatsUpdate.totalMatchesWon + userStatsUpdate.totalMatchesLost;
      userStatsUpdate.winLossRatio = newTotalMatches > 0
        ? (userStatsUpdate.totalMatchesWon / newTotalMatches).toFixed(3)
        : 0;

      FirestoreService.updateUserStats(userId, userStatsUpdate); // Update user stats in Firestore.
    }
    onMatchEnd(); // Callback to parent component (App) to navigate to stats page.
  }, [currentUser, matchFormat, opponentScore, playerScore, userId, onMatchEnd]);

  // Ends the current player's turn, checking for game win and switching players.
  const endTurn = useCallback(() => {
    if (!isPlaying) return;

    // Check for current game winner (15 checkers borne off).
    if (boardState.home.white === 15) {
        setModalMessage(`White wins this game!`);
        setShowModal(true);
        setPlayerScore(prev => prev + 1); // Increment match score.
        initializeBoard(); // Reset board for next game.
        setDice([0, 0]);
        setAvailableDice([]);
        setSelectedPoint(null);
        setPossibleMovesInfo([]); // Clear possible moves info
        setMustReenterFromBar(false);
        setCurrentPlayer('white'); // White always starts the next game.
        setGameMessage("New game started. White to roll.");
        setMoveHistory([]); // Clear history for new game/turn
        return;
    } else if (boardState.home.black === 15) {
        setModalMessage(`Black wins this game!`);
        setShowModal(true);
        setOpponentScore(prev => prev + 1);
        initializeBoard();
        setDice([0, 0]);
        setAvailableDice([]);
        setSelectedPoint(null);
        setPossibleMovesInfo([]); // Clear possible moves info
        setMustReenterFromBar(false);
        setCurrentPlayer('black'); // Black starts the next game.
        setGameMessage("New game started. Black to roll.");
        setMoveHistory([]); // Clear history for new game/turn
        return;
    }

    // If no game winner, switch to the other player's turn.
    setCurrentPlayer(prev => prev === 'white' ? 'black' : 'white');
    setDice([0, 0]);
    setAvailableDice([]); // Clear dice for the next turn.
    setSelectedPoint(null);
    setPossibleMovesInfo([]); // Clear possible moves info
    setMustReenterFromBar(false); // Reset bar state for the next turn.
    setGameMessage(`Turn ended. It's now ${getOpponentColor(currentPlayer).charAt(0).toUpperCase() + getOpponentColor(currentPlayer).slice(1)}'s turn. Roll the dice!`);
    setMoveHistory([]); // Clear history for the new turn
  }, [isPlaying, boardState.home.white, boardState.home.black, initializeBoard, currentPlayer, getOpponentColor, endMatch]);


  // Performs a checker move on the board.
  // diceToConsume is now an array of numbers, e.g., [4], [2, 4], [3, 3, 3]
  const performMove = useCallback((fromPoint, toPoint, diceToConsume) => {
    const newBoardState = JSON.parse(JSON.stringify(boardState)); // Deep copy to ensure immutability.

    let checkerToMove;
    if (fromPoint === 'bar') {
        // Move from the bar.
        if (newBoardState.bar[currentPlayer] > 0) {
            newBoardState.bar[currentPlayer]--;
            checkerToMove = currentPlayer;
        } else {
            console.error("No checkers on bar to move!");
            setGameMessage("Error: No checkers on bar to move!");
            return;
        }
    } else {
        // Move from a regular point.
        const sourcePoint = newBoardState.points[fromPoint - 1];
        if (sourcePoint.checkers.length === 0 || sourcePoint.checkers[0] !== currentPlayer) {
            console.error("Invalid move: No checker of current player at source point.");
            setGameMessage("Error: No checker of current player at source point.");
            return;
        }
        checkerToMove = sourcePoint.checkers.pop(); // Remove checker from source.
    }

    // Determine if a blot was hit BEFORE modifying newBoardState
    let hitOpponentChecker = false;
    let hitCheckerColor = null;

    // Point 0 is white's bear-off, Point 25 is black's bear-off
    const isBearingOff = (toPoint === 0 || toPoint === 25);

    if (!isBearingOff && newBoardState.points[toPoint - 1].checkers.length === 1 && newBoardState.points[toPoint - 1].checkers[0] === getOpponentColor(currentPlayer)) {
        hitOpponentChecker = true;
        hitCheckerColor = getOpponentColor(currentPlayer); // The color of the checker that was hit
    }

    // Handle bearing off (moving to point 0 or 25).
    if (isBearingOff) {
        if (toPoint === 0) { // White bearing off
            newBoardState.home.white++;
        } else { // Black bearing off (toPoint === 25)
            newBoardState.home.black++;
        }
        setBoardState(newBoardState);
        setGameMessage(`${currentPlayer.charAt(0).toUpperCase() + currentPlayer.slice(1)} checker borne off!`);
        setSelectedPoint(null); // Deselect.

        // Consume the used dice.
        let newAvailableDice = [...availableDice];
        diceToConsume.forEach(die => {
            const index = newAvailableDice.indexOf(die);
            if (index > -1) {
                newAvailableDice.splice(index, 1);
            } else {
                console.warn(`Attempted to consume die ${die} but it was not found in available dice:`, newAvailableDice);
            }
        });
        setAvailableDice(newAvailableDice);
        setPossibleMovesInfo([]); // Clear possible moves info

        // Record the move in history
        setMoveHistory(prevHistory => [...prevHistory, {
            fromPoint,
            toPoint,
            checkerColor: currentPlayer,
            hitOpponentChecker: false, // Bearing off never hits opponent
            hitCheckerColor: null,
            usedDice: diceToConsume // Store the array of dice used
        }]);

        // Check for immediate game win after bearing off.
        if (newBoardState.home.white === 15 || newBoardState.home.black === 15) {
            endTurn();
        } else {
            // Check if any further moves are possible with the remaining dice and updated board state
            const hasMoreMoves = checkIfAnyPossibleMoves(newBoardState, currentPlayer, newAvailableDice);
            if (newAvailableDice.length === 0 || !hasMoreMoves) {
                setTimeout(endTurn, 1000); // Add a small delay for message visibility
            }
        }
        return;
    }

    // If a blot was hit, move opponent's checker to the bar. This happens before adding current player's checker.
    if (hitOpponentChecker) {
      newBoardState.points[toPoint - 1].checkers.pop(); // Remove opponent's checker.
      newBoardState.bar[hitCheckerColor]++; // Send it to the opponent's bar.
      setGameMessage(`Blot hit! ${hitCheckerColor.charAt(0).toUpperCase() + hitCheckerColor.slice(1)} checker sent to the bar.`);
    }

    newBoardState.points[toPoint - 1].checkers.push(checkerToMove); // Add current player's checker to destination.
    setBoardState(newBoardState);
    setSelectedPoint(null);
    setGameMessage("Move made!");

    // Record the move in history
    setMoveHistory(prevHistory => [...prevHistory, {
        fromPoint,
        toPoint,
        checkerColor: currentPlayer,
        hitOpponentChecker,
        hitCheckerColor,
        usedDice: diceToConsume // Store the array of dice used
    }]);

    // Consume the used dice after the move.
    let newAvailableDice = [...availableDice];
    diceToConsume.forEach(die => {
        const index = newAvailableDice.indexOf(die);
        if (index > -1) {
            newAvailableDice.splice(index, 1);
        } else {
            console.warn(`Attempted to consume die ${die} but it was not found in available dice:`, newAvailableDice);
        }
    });
    setAvailableDice(newAvailableDice);
    setPossibleMovesInfo([]); // Clear possible moves info

    // If no more dice are available after this move, or no more moves possible, automatically end the turn.
    const hasMoreMoves = checkIfAnyPossibleMoves(newBoardState, currentPlayer, newAvailableDice);
    if (newAvailableDice.length === 0 || !hasMoreMoves) {
        setTimeout(endTurn, 1000); // Add a small delay for message visibility
    }

  }, [boardState, availableDice, currentPlayer, endTurn, getOpponentColor, checkIfAnyPossibleMoves, setMoveHistory]); // Removed whitePath, blackPath from dependencies as they're not direct args

  // Handles rolling the dice. This function is passed to the Dice component as a callback.
  const rollDiceHandler = useCallback((die1, die2) => { // Now accepts die values as arguments
    if (!isPlaying) return;
    const newAvailableDice = die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
    setAvailableDice(newAvailableDice);
    setGameMessage(`${currentPlayer === 'white' ? (currentUser?.displayName || 'White Player') : 'Black Player'} rolled a ${die1} and a ${die2}. Now make your move.`);
    setSelectedPoint(null);
    setPossibleMovesInfo([]); // Clear possible moves info.
    setMoveHistory([]); // Clear move history at the start of a new roll/turn

    // Check if any moves are possible with the new dice and current board state
    const initialPossibleMoves = checkIfAnyPossibleMoves(boardState, currentPlayer, newAvailableDice);

    if (boardState.bar[currentPlayer] > 0 && !initialPossibleMoves) {
        // If player has pieces on the bar AND cannot re-enter, skip turn.
        setGameMessage(`${currentPlayer.charAt(0).toUpperCase() + currentPlayer.slice(1)} has checkers on the bar and no valid moves. Turn skipped.`);
        setTimeout(endTurn, 2000); // Give player time to read message
        return; // Important: exit here to prevent normal turn flow
    } else if (!initialPossibleMoves) {
        // Normal case: no moves possible, but no checkers on bar
        setGameMessage(`No possible moves for ${currentPlayer.charAt(0).toUpperCase() + currentPlayer.slice(1)} with these dice. Turn ends.`);
        setTimeout(endTurn, 1500); // Give player a moment to read message
    }
  }, [isPlaying, currentPlayer, currentUser, checkIfAnyPossibleMoves, boardState, endTurn, setMoveHistory]); // Removed whitePath, blackPath from dependencies as they're not direct args


  // Starts a new backgammon match.
  const startMatch = () => {
    setPlayerScore(0);
    setOpponentScore(0);
    setGameMessage(`Match started! First to ${Math.ceil(matchFormat / 2)} games wins. White rolls first!`);
    setIsPlaying(true);
    setDice([0,0]);
    setAvailableDice([]);
    setCurrentPlayer('white');
    initializeBoard(); // Reset board to initial state.
    setSelectedPoint(null);
    setPossibleMovesInfo([]); // Clear possible moves info
    setMustReenterFromBar(false);
    setMoveHistory([]); // Clear history at match start
  };

  // Closes the general info modal.
  const closeModal = () => {
    setShowModal(false);
  };

  const undoLastMove = useCallback(() => {
    if (moveHistory.length === 0) {
        setGameMessage("No moves to undo!");
        return;
    }

    const lastMove = moveHistory[moveHistory.length - 1];
    const newMoveHistory = moveHistory.slice(0, -1); // Remove the last move
    setMoveHistory(newMoveHistory);

    const newBoardState = JSON.parse(JSON.stringify(boardState));

    // Determine if it was a bearing off move
    const isBearingOffMove = (lastMove.toPoint === 0 || lastMove.toPoint === 25);

    // 1. Move checker back
    if (isBearingOffMove) {
        if (lastMove.toPoint === 0) { // White bearing off
            newBoardState.home.white--;
        } else { // Black bearing off
            newBoardState.home.black--;
        }
        // Place checker back on its original 'fromPoint'
        newBoardState.points[lastMove.fromPoint - 1].checkers.push(lastMove.checkerColor);
    } else {
        // Regular move: move checker from 'toPoint' back to 'fromPoint'
        if (!newBoardState.points[lastMove.toPoint - 1] || newBoardState.points[lastMove.toPoint - 1].checkers.length === 0 ||
            newBoardState.points[lastMove.toPoint - 1].checkers[newBoardState.points[lastMove.toPoint - 1].checkers.length - 1] !== lastMove.checkerColor) {
            console.error("Error during undo: No checker of correct color at toPoint to move back.");
            setGameMessage("Error undoing move. Please restart game if issues persist.");
            return;
        }
        newBoardState.points[lastMove.toPoint - 1].checkers.pop(); // Remove from destination
        // Handle move from bar
        if (lastMove.fromPoint === 'bar') {
            newBoardState.bar[lastMove.checkerColor]++;
        } else {
            newBoardState.points[lastMove.fromPoint - 1].checkers.push(lastMove.checkerColor); // Return to original point
        }
    }

    // 2. If a blot was hit, move opponent's checker back from the bar
    if (lastMove.hitOpponentChecker && lastMove.hitCheckerColor) {
        newBoardState.bar[lastMove.hitCheckerColor]--;
        // For a blot, the opponent's checker was sent to the bar FROM `lastMove.toPoint`
        if (lastMove.toPoint !== 0 && lastMove.toPoint !== 25) { // Ensure it wasn't a bear-off point itself
            newBoardState.points[lastMove.toPoint - 1].checkers.push(lastMove.hitCheckerColor); // Put opponent's checker back
        }
    }

    setBoardState(newBoardState);

    // 3. Refund the dice used in the last move
    setAvailableDice(prevDice => {
        let tempDice = [...prevDice];
        lastMove.usedDice.forEach(die => {
            tempDice.push(die); // Add each die back
        });
        return tempDice.sort((a, b) => b - a); // Sort for consistent display (descending)
    });


    // Clear selection and possible moves after undo
    setSelectedPoint(null);
    setPossibleMovesInfo([]);
    setGameMessage(`Last move undone.`);

    // Re-evaluate if re-entry from bar is needed after undo
    // Important: recalculate based on the *new* board state after undo
    if (newBoardState.bar[currentPlayer] > 0) {
        setMustReenterFromBar(true);
        // The available dice for recalculation should include the refunded dice
        const updatedAvailableDice = [...availableDice, ...lastMove.usedDice]; // This may not be perfectly accurate if availableDice was already modified for other parts of the turn.
                                                                                // For true robustness, a full state snapshot per move is ideal.
                                                                                // For now, this assumes undoing to a point where the only available dice are what's remaining + refunded from this move.
        const availableEntryMoves = calculatePossibleMoves('bar', updatedAvailableDice, currentPlayer, newBoardState);
        setPossibleMovesInfo(availableEntryMoves);
    } else {
        setMustReenterFromBar(false);
    }

}, [moveHistory, boardState, availableDice, currentPlayer, getOpponentColor, isPointBlocked, setAvailableDice, setSelectedPoint, setPossibleMovesInfo, setGameMessage, setMustReenterFromBar, calculatePossibleMoves]);


  // Effect to initialize the board on component mount or `initializeBoard` change.
  useEffect(() => {
    initializeBoard();
  }, [initializeBoard]);

  // Effect to check for match end conditions.
  useEffect(() => {
    if (isPlaying) {
      // If either player reaches half the match format score (rounded up), the match ends.
      if (playerScore >= Math.ceil(matchFormat / 2)) {
        endMatch(true); // Current player won the match.
      } else if (opponentScore >= Math.ceil(matchFormat / 2)) {
        endMatch(false); // Opponent won the match.
      }
    }
  }, [playerScore, opponentScore, isPlaying, matchFormat, endMatch]);


  // Effect to manage `mustReenterFromBar` state and highlight valid bar entry moves.
  useEffect(() => {
    if (isPlaying && boardState.bar[currentPlayer] > 0) {
      setMustReenterFromBar(true);
      setGameMessage(`${currentPlayer.charAt(0).toUpperCase() + currentPlayer.slice(1)} must re-enter checkers from the bar! Click on an available highlighted point to place your checker.`);
      if (availableDice.length > 0) {
          // Calculate possible entry moves based on current dice and board state
          const availableEntryMoves = calculatePossibleMoves('bar', availableDice, currentPlayer, boardState);
          setPossibleMovesInfo(availableEntryMoves);
      }
    } else {
      setMustReenterFromBar(false);
      // Clear highlights if no bar checkers and no checker is currently selected.
      if(selectedPoint === null && possibleMovesInfo.length > 0) {
          setPossibleMovesInfo([]);
      }
    }
  }, [boardState.bar, currentPlayer, isPlaying, availableDice, selectedPoint, calculatePossibleMoves, boardState, possibleMovesInfo.length]);


  // Effect to update possible moves when selected point, available dice, or player changes.
  useEffect(() => {
    if (selectedPoint !== null && availableDice.length > 0) {
        const moves = calculatePossibleMoves(selectedPoint, availableDice, currentPlayer, boardState);
        // Only update if the moves array is different to prevent unnecessary renders
        if (JSON.stringify(moves) !== JSON.stringify(possibleMovesInfo)) {
            setPossibleMovesInfo(moves);
        }
    } else if (selectedPoint === null && possibleMovesInfo.length > 0 && !mustReenterFromBar) {
      // Clear possible moves when nothing is selected, unless re-entering from bar
      setPossibleMovesInfo([]);
    }
  }, [selectedPoint, availableDice, currentPlayer, boardState, calculatePossibleMoves, possibleMovesInfo, mustReenterFromBar]);


  // Handles a click on a board point.
  const handlePointClick = (pointNumber) => {
    if (!isPlaying || availableDice.length === 0) {
      setGameMessage("Please roll the dice and ensure moves are available!");
      return;
    }

    // If the clicked point is already selected, deselect it.
    if (selectedPoint === pointNumber) {
        setSelectedPoint(null);
        setPossibleMovesInfo([]); // Clear possible moves info
        setGameMessage("Checker deselected.");
        return;
    }

    // Handle clicks on bear-off areas as target points
    const isClickOnBearOffArea = (pointNumber === 0 || pointNumber === 25);
    const targetMoveInfo = possibleMovesInfo.find(move => move.targetPoint === pointNumber);

    if (mustReenterFromBar) {
        // If checkers are on the bar, the only allowed action is to re-enter them.
        if (isClickOnBearOffArea) { // Cannot bear off from bar
            setGameMessage("You must re-enter checkers from the bar first.");
            return;
        }
        if (targetMoveInfo) {
            performMove('bar', pointNumber, targetMoveInfo.diceUsed);
        } else {
            setGameMessage("You must re-enter checkers from the bar. Please click one of the highlighted points.");
        }
        return;
    }

    // If a checker is already selected, try to move it to the clicked point (including bear-off areas).
    if (selectedPoint !== null && targetMoveInfo) {
        performMove(selectedPoint, pointNumber, targetMoveInfo.diceUsed); // Pass the exact dice used
    } else {
        // No checker selected, or clicked an invalid target. Try to select a checker.
        if (isClickOnBearOffArea) { // Cannot select a checker from a bear-off area
            setGameMessage("You cannot select checkers from the bear-off area.");
            setSelectedPoint(null);
            setPossibleMovesInfo([]);
            return;
        }

        const pointCheckers = boardState.points[pointNumber - 1].checkers;
        if (pointCheckers.length > 0 && pointCheckers[0] === currentPlayer) {
          setSelectedPoint(pointNumber);
          // When a checker is selected, calculate and store its possible moves including the dice used.
          const calculatedMoves = calculatePossibleMoves(pointNumber, availableDice, currentPlayer, boardState);
          setPossibleMovesInfo(calculatedMoves);
          setGameMessage(`Selected checker from point ${pointNumber}. Now choose a destination.`);
        } else {
          setGameMessage("You don't have checkers on this point or it's not your turn. Please select your own checker.");
          setSelectedPoint(null); // Ensure no point is selected if invalid click.
          setPossibleMovesInfo([]); // Clear possible moves info
        }
      }
    };

  return (
    <div className="bg-white p-6 rounded-xl shadow-2xl max-w-5xl mx-auto my-8">
      <h2 className="text-3xl font-extrabold text-blue-800 mb-6 text-center">Play Backgammon</h2>
      <p className="text-lg text-gray-700 mb-4 text-center">
        Current User: <span className="font-semibold text-blue-600">{currentUser?.displayName || 'Guest'}</span> (ID: <span className="font-mono text-xs break-words">{userId || 'N/A'}</span>)
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="p-4 bg-blue-50 rounded-lg shadow-inner col-span-1">
          <h3 className="text-xl font-bold text-blue-700 mb-3">Match Settings</h3>
          <label htmlFor="match-format" className="block text-gray-700 font-medium mb-2">
            Match Format (Best of N games):
          </label>
          <select
            id="match-format"
            className="w-full p-2 border border-gray-300 rounded-lg bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            value={matchFormat}
            onChange={(e) => setMatchFormat(parseInt(e.target.value))}
            disabled={isPlaying}
          >
            <option value={7}>Best of 7</option>
            <option value={9}>Best of 9</option>
            <option value={11}>Best of 11</option>
            <option value={13}>Best of 13</option>
            <option value={15}>Best of 15</option>
          </select>
            <div className="mt-4">
                <button
                    onClick={() => setSoundEnabled(prev => !prev)}
                    className={`w-full py-2 px-4 rounded-md font-semibold transition-colors ${
                        soundEnabled ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-800'
                    }`}
                >
                    Toggle Dice Sound: {soundEnabled ? 'On' : 'Off'}
                </button>
            </div>
        </div>

        <div className="p-4 bg-green-50 rounded-lg shadow-inner flex flex-col justify-between col-span-2">
          <div>
            <h3 className="text-xl font-bold text-green-700 mb-3">Game Status</h3>
            <p className="text-gray-700 font-medium text-lg">{gameMessage}</p>
          </div>
          <div className="mt-4 text-center">
            <p className="text-2xl font-bold text-gray-800">
              Score: {playerScore} - {opponentScore}
            </p>
            {isPlaying && availableDice.length > 0 && (
                <p className="text-md text-gray-600 mt-1">Remaining Dice: {availableDice.join(', ')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Backgammon Board & Dice Area */}
      <div className="flex flex-col md:flex-row gap-6 items-start">
        <div className="w-full md:w-3/4">
          <BackgammonBoard
            board={boardState}
            currentPlayer={currentPlayer}
            onPointClick={handlePointClick}
            selectedPoint={selectedPoint}
            possibleMovePoints={possibleMovesInfo.map(m => m.targetPoint)} // Pass only the points for highlighting
            currentDiceValues={dice}
          />
        </div>
        <div className="w-full md:w-1/4 flex flex-col gap-4">
          <Dice dice={dice} setDice={setDice} rollDice={rollDiceHandler} disabled={!isPlaying || availableDice.length > 0} soundEnabled={soundEnabled} />
          {isPlaying && (
            <div className="flex flex-col gap-2 p-4 bg-gray-50 rounded-lg shadow-inner">
                <h4 className="text-md font-bold text-gray-700">Turn Actions</h4>
                <button
                    onClick={undoLastMove}
                    disabled={moveHistory.length === 0 || !isPlaying}
                    className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 px-4 rounded-md shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Undo Last Move
                </button>
                {/* Manual win/lose buttons for simulating a *game outcome* within the match, useful for testing match score. */}
                <button
                    onClick={() => {
                        setConfirmModalAction(() => () => { // Set the action to be performed on confirmation.
                            const newBoardState = JSON.parse(JSON.stringify(boardState));
                            newBoardState.home.white = 15; // Force White to win.
                            setBoardState(newBoardState);
                            endTurn(); // Trigger win logic and next game/match end.
                            setShowConfirmModal(false); // Close the confirmation modal.
                        });
                        setShowConfirmModal(true); // Show the confirmation modal.
                        setModalMessage("Are you sure you want to simulate White winning this game?"); // Set confirmation message.
                    }}
                    className="bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded-md shadow-sm transition-colors"
                >
                    Simulate White Win Game
                </button>
                <button
                    onClick={() => {
                        setConfirmModalAction(() => () => { // Set the action to be performed on confirmation.
                            const newBoardState = JSON.parse(JSON.stringify(boardState));
                            newBoardState.home.black = 15; // Force Black to win.
                            setBoardState(newBoardState);
                            endTurn(); // Trigger win logic and next game/match end.
                            setShowConfirmModal(false); // Close the confirmation modal.
                        });
                        setShowConfirmModal(true); // Show the confirmation modal.
                        setModalMessage("Are you sure you want to simulate Black winning this game?"); // Set confirmation message.
                    }}
                    className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-md shadow-sm transition-colors"
                >
                    Simulate Black Win Game
                </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap justify-center gap-4 mt-8">
        {!isPlaying ? (
          <button
            onClick={startMatch}
            className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-8 rounded-full shadow-lg transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-purple-300"
          >
            Start New Match
          </button>
        ) : null}
      </div>

      {/* Modal for match end notifications */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-8 shadow-2xl text-center max-w-sm w-full border-t-8 border-blue-600">
            <h3 className="text-2xl font-bold text-gray-800 mb-4">Match Finished!</h3>
            <p className="text-lg text-gray-700 mb-6">{modalMessage}</p>
            <button
              onClick={closeModal}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-full shadow-md transition-all duration-300 transform hover:scale-105"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {showConfirmModal && (
          <ConfirmModal
              message={modalMessage} // Reusing modalMessage for confirmation message.
              onConfirm={confirmModalAction} // Execute the stored action on confirm.
              onCancel={() => setShowConfirmModal(false)} // Just close on cancel.
          />
      )}
    </div>
  );
};

// --- Other Shared Components ---

// Header Component: Navigation and user info display.
const Header = ({ onNavigate }) => {
  const { currentUser, logout } = useContext(AuthContext);

  return (
    <header className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-4 shadow-lg rounded-b-lg mb-6">
      <div className="container mx-auto flex flex-col sm:flex-row justify-between items-center">
        <h1 className="text-3xl font-extrabold text-yellow-300 tracking-wide mb-3 sm:mb-0">
          Backgammon Royale
        </h1>
        <nav className="flex flex-wrap justify-center sm:justify-end gap-3 sm:gap-4">
          <button
            onClick={() => onNavigate('game')}
            className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-blue-900 font-semibold rounded-lg shadow-md transition-transform transform hover:scale-105 flex items-center gap-2"
          >
            {/* Using text for icons as lucide-react is not available in this environment */}
            Game
          </button>
          <button
            onClick={() => onNavigate('stats')}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg shadow-md transition-transform transform hover:scale-105 flex items-center gap-2"
          >
            Rankings
          </button>
          {currentUser && !currentUser.isAnonymous && (
            <div className="flex items-center gap-2 bg-blue-500 px-4 py-2 rounded-lg shadow-md">
              <img
                src={currentUser.photoURL || 'https://placehold.co/24x24/cccccc/000000?text=U'}
                alt="User Avatar"
                className="w-6 h-6 rounded-full border border-yellow-300"
              />
              <span className="font-medium text-sm hidden md:block">{currentUser.displayName || 'Guest'}</span>
              <button
                onClick={logout}
                className="px-3 py-1 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-lg shadow-inner transition-colors"
              >
                Logout
              </button>
            </div>
          )}
        </nav>
      </div>
    </header>
  );
};

// LoginPage Component: Handles user authentication.
const LoginPage = () => {
  const { signInWithGoogle, loadingAuth } = useContext(AuthContext);

  if (loadingAuth) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-100">
        <div className="text-xl font-semibold text-gray-700">Loading authentication...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-300 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-xl shadow-2xl max-w-md w-full text-center border-t-4 border-blue-500">
        <h2 className="text-3xl font-extrabold text-gray-800 mb-6">Welcome to Backgammon Royale</h2>
        <p className="text-lg text-gray-600 mb-8">
          Sign in to play games, track your stats, and see how you rank against other players!
        </p>
        <button
          onClick={signInWithGoogle}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-full shadow-lg transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-blue-300 flex items-center justify-center mx-auto"
        >
          {/* Using inline SVG for Google icon as a fallback */}
          <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.675 12.001c0-.78-.068-1.536-.182-2.272H12v4.265h6.398c-.282 1.39-1.048 2.583-2.227 3.376v2.774h3.565c2.08-1.922 3.284-4.743 3.284-8.143z" fill="#4285F4"/>
            <path d="M12 23c3.228 0 5.922-1.066 7.896-2.883l-3.565-2.774c-.98.667-2.245 1.054-3.561 1.054-2.766 0-5.1-1.868-5.952-4.382H2.42v2.851C4.305 20.258 7.964 23 12 23z" fill="#34A853"/>
            <path d="M5.952 14.265c-.25-1.05-.39-2.16-.39-3.265s.14-2.215.39-3.265V4.881H2.42C.876 7.234 0 9.567 0 12s.876 4.766 2.42 7.119L5.952 14.265z" fill="#FBBC05"/>
            <path d="M12 4.615c1.761 0 3.35.602 4.606 1.795l3.16-3.16c-1.85-1.74-4.26-2.83-7.766-2.83C7.964 0 4.305 2.742 2.42 7.119l3.532 2.774C6.9 6.483 9.234 4.615 12 4.615z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </button>
        <p className="text-sm text-gray-500 mt-6">
          Your current user ID is: <span className="font-mono text-gray-700 break-words">{auth?.currentUser?.uid || 'Not signed in'}</span>
        </p>
        <p className="mt-4 text-xs text-gray-500">
          By signing in, you agree to our terms of service and privacy policy.
        </p>
      </div>
    </div>
  );
};

// StatsPage Component: Displays player rankings and statistics.
const StatsPage = () => {
  const { currentUser, userId, loadingAuth } = useContext(AuthContext);
  const [users, setUsers] = useState([]);
  const [loadingStats, setLoadingStats] = useState(true);
  const [sortBy, setSortBy] = useState('winLossRatio'); // Criteria for sorting.
  const [sortOrder, setSortOrder] = useState('desc');   // Sorting order.
  const [filterType, setFilterType] = useState('all'); // Filter for 'all' or 'mine' stats.

  useEffect(() => {
    // Only proceed if Firestore is initialized and authentication is loaded.
    if (!db || loadingAuth) {
      if (!db) console.warn("StatsPage: db is not initialized.");
      if (loadingAuth) console.log("StatsPage: Auth is still loading.");
      return;
    }

    setLoadingStats(true);
    console.log("StatsPage: Attempting to fetch users from Firestore...");
    // Fetch users in real-time.
    const unsubscribe = FirestoreService.getUsers((fetchedUsers) => {
      console.log("StatsPage: Fetched users:", fetchedUsers);
      // Process fetched users to calculate win/loss ratio and total matches.
      const processedUsers = fetchedUsers.map(user => {
        const totalMatches = (user.totalMatchesWon || 0) + (user.totalMatchesLost || 0);
        return {
          ...user,
          winLossRatio: totalMatches > 0 ? ((user.totalMatchesWon || 0) / totalMatches) : 0,
          totalMatches: totalMatches,
        };
      });
      setUsers(processedUsers);
      setLoadingStats(false); // Stats loading complete.
      console.log("StatsPage: Users state updated, loadingStats set to false.");
    });

    // Cleanup function: unsubscribe from Firestore listener.
    return () => {
        console.log("StatsPage: Cleaning up Firestore listener.");
        unsubscribe();
    };
  }, [db, loadingAuth]); // Re-run effect when db or loadingAuth changes.

  // Filter and sort users based on current criteria.
  const sortedAndFilteredUsers = [...users]
    .filter(user => {
      if (filterType === 'mine' && userId) {
        return user.id === userId; // Only show current user's stats.
      }
      return true; // Show all users.
    })
    .sort((a, b) => {
      let valA, valB;
      // Assign values based on sorting criteria.
      if (sortBy === 'winLossRatio') {
        valA = a.winLossRatio;
        valB = b.winLossRatio;
      } else if (sortBy === 'totalMatchesWon') {
        valA = a.totalMatchesWon || 0;
        valB = b.totalMatchesWon || 0;
      } else if (sortBy === 'totalGamesWon') {
        valA = a.totalGamesWon || 0;
        valB = b.totalGamesWon || 0;
      } else if (sortBy === 'totalMatches') {
        valA = a.totalMatches || 0;
        valB = b.totalMatches || 0;
      } else { // Default to totalGamesPlayed
        valA = a.totalGamesPlayed || 0;
        valB = b.totalGamesPlayed || 0;
      }

      // Apply sorting order.
      if (sortOrder === 'asc') {
        return valA - valB;
      } else {
        return valB - valA; // Corrected the sorting logic to use valA and valB consistently
      }
    });

  if (loadingAuth || loadingStats) {
    return <div className="text-center py-8">Loading rankings...</div>;
  }

  return (
    <div className="bg-white p-6 rounded-xl shadow-2xl max-w-6xl mx-auto my-8">
      <h2 className="text-3xl font-extrabold text-green-800 mb-6 text-center">Player Rankings</h2>

      <div className="flex flex-col md:flex-row gap-4 mb-6 p-4 bg-gray-50 rounded-lg shadow-inner justify-between items-center">
        <div className="flex items-center gap-2">
          <label htmlFor="filter" className="font-semibold text-gray-700">Filter:</label>
          <select
            id="filter"
            className="p-2 border border-gray-300 rounded-lg bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="all">All Players</option>
            {currentUser && !currentUser.isAnonymous && <option value="mine">My Stats</option>}
          </select>
        </div>

        <div className="flex items-center gap-2 mt-4 md:mt-0">
          <label htmlFor="sortBy" className="font-semibold text-gray-700">Sort By:</label>
          <select
            id="sortBy"
            className="p-2 border border-gray-300 rounded-lg bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="winLossRatio">Win/Loss Ratio</option>
            <option value="totalMatchesWon">Total Matches Won</option>
            <option value="totalGamesWon">Total Games Won</option>
            <option value="totalGamesPlayed">Total Games Played (within matches)</option>
            <option value="totalMatches">Total Matches Played</option>
          </select>
        </div>

        <div className="flex items-center gap-2 mt-4 md:mt-0">
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="p-2 bg-gray-200 hover:bg-gray-300 rounded-lg shadow-sm transition-colors flex items-center gap-1"
          >
            {sortOrder === 'asc' ? (
                <span>&#8593; Ascending</span>
              ) : (
                <span>&#8595; Descending</span>
              )}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg shadow-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-blue-100">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Rank</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Player</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">User ID</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Matches Won</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Matches Lost</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Win/Loss Ratio</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Games Won</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Games Lost</th>
              <th className="px-4 py-3 whitespace-nowrap text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Total Games Played</th>
              <th className="px-4 py-3 whitespace-nowrap text-left text-xs font-medium text-blue-700 uppercase tracking-wider">Total Matches Played</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sortedAndFilteredUsers.length === 0 ? (
              <tr>
                <td colSpan="10" className="px-4 py-4 text-center text-gray-500">
                  No players found or no data available. Play some matches!
                </td>
              </tr>
            ) : (
              sortedAndFilteredUsers.map((user, index) => (
                <tr key={user.id} className={`${user.id === userId ? 'bg-yellow-50 font-bold' : 'hover:bg-gray-50'}`}>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">{index + 1}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-blue-800 flex items-center gap-2">
                    <img
                      src={user.photoURL || 'https://placehold.co/24x24/cccccc/000000?text=U'}
                      alt="Avatar"
                      className="w-6 h-6 rounded-full border border-gray-300"
                    />
                    {user.displayName}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700 font-mono text-xs break-words">{user.id}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalMatchesWon || 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalMatchesLost || 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.winLossRatio.toFixed(3)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalGamesWon || 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalGamesLost || 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalGamesPlayed || 0}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">{user.totalMatches || 0}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-6 text-sm text-gray-500 text-center">
        Note: "Total Games Played" refers to individual games within a best-of-N match.
      </p>
    </div>
  );
};

// --- Main App Component ---
// This component handles routing and overall application layout.
const App = () => {
  const [currentPage, setCurrentPage] = useState('game'); // State to control which page is displayed.
  const { currentUser, loadingAuth } = useContext(AuthContext); // Access authentication state from context.

  console.log("App component rendering. CurrentPage:", currentPage, "LoadingAuth:", loadingAuth, "CurrentUser:", currentUser?.uid);

  // Display a loading indicator while authentication state is being determined.
  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-gray-100 font-inter antialiased flex items-center justify-center">
        <div className="text-xl font-semibold text-gray-700">Loading application...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 font-inter antialiased">
      <Header onNavigate={setCurrentPage} /> {/* Header for navigation. */}
      <main className="container mx-auto p-4">
        {/* Conditional rendering: show LoginPage if not authenticated, otherwise show game or stats. */}
        {!currentUser || currentUser.isAnonymous ? (
          <LoginPage />
        ) : (
          <>
            {currentPage === 'game' && <BackgammonGame onMatchEnd={() => setCurrentPage('stats')} />}
            {currentPage === 'stats' && <StatsPage />}
          </>
        )}
      </main>
    </div>
  );
};

// The top-level component that wraps the entire application with AuthProvider.
// This is crucial for useContext(AuthContext) to work throughout the app.
const RootApp = () => (
    <AuthProvider>
        <App />
    </AuthProvider>
);

export default RootApp;
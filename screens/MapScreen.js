import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform, Alert, Image, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { api } from '../services/api';
import { t } from '../i18n/translations';
import { getSizeLabel, getSizeColor, checkSizeCompatibility } from '../data/carDatabase';
import CreateParkingScreen from './CreateParkingScreen';
import CreateHelpRequestScreen from './CreateHelpRequestScreen';
import HelpStatusScreen from './HelpStatusScreen';
import ProfileScreen from './ProfileScreen';
import FiltersModal from '../components/FiltersModal';
import SearchBar from '../components/SearchBar';
import MyParkingStatusScreen from './MyParkingStatusScreen';
import MyBookingStatusScreen from './MyBookingStatusScreen';
import AdminScreen from './AdminScreen';
import RatingModal from '../components/RatingModal';

let MapView, Marker;
if (Platform.OS !== 'web') {
  const Maps = require('react-native-maps');
  MapView = Maps.default;
  Marker = Maps.Marker;
}

function WebMap({ parkings, onMarkerPress, region, bookerLocation, userCarSize, helpRequests, onHelpMarkerPress }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    if (!window.L) {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => initMap();
      document.head.appendChild(script);
    } else { initMap(); }
    return () => { if (mapInstanceRef.current) mapInstanceRef.current.remove(); };
  }, []);

  useEffect(() => { if (mapInstanceRef.current && window.L) updateMarkers(); }, [parkings, bookerLocation, helpRequests]);
  useEffect(() => { if (mapInstanceRef.current && region) mapInstanceRef.current.setView([region.latitude, region.longitude], 15); }, [region]);

  const initMap = () => {
    const style = document.createElement("style");
    style.textContent = ".custom-marker { transition: none !important; } .custom-marker:focus { outline: none; } .leaflet-marker-icon:focus { outline: none; }";
    document.head.appendChild(style);
    if (!mapRef.current || !window.L) return;
    const map = window.L.map(mapRef.current).setView([region?.latitude || 40.7128, region?.longitude || -74.0060], 13);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    mapInstanceRef.current = map;
    updateMarkers();
  };

  const updateMarkers = () => {
    if (!mapInstanceRef.current || !window.L) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    
    const sizeOrder = ['S', 'M', 'L', 'XL'];
    
    parkings.forEach(parking => {
      const parkingSize = parking.ownerCar?.size;
      const userIdx = sizeOrder.indexOf(userCarSize);
      const parkingIdx = sizeOrder.indexOf(parkingSize);
      
      let color = '#44aa44';
      if (userCarSize && parkingSize) {
        if (userIdx < parkingIdx) {
          color = '#44aa44';
        } else if (userIdx === parkingIdx) {
          color = '#44aa44';
        } else if (userIdx === parkingIdx + 1) {
          color = '#ffaa00';
        } else {
          color = '#ff4444';
        }
      }
      
      const icon = window.L.divIcon({
        className: 'custom-marker',
        html: `<div style="background-color:${color};width:30px;height:30px;border-radius:50%;border:3px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;">${parking.price}</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15]
      });
      const marker = window.L.marker([parking.location.lat, parking.location.lng], { icon })
        .addTo(mapInstanceRef.current).on('click', () => onMarkerPress(parking));
      markersRef.current.push(marker);
    });


    // Help request markers
    if (helpRequests) { console.log("Drawing help markers:", helpRequests.length);
      helpRequests.forEach(help => {
        const helpIcon = window.L.divIcon({
          className: 'help-marker',
          html: `<div style="background-color:#ff6b6b;width:35px;height:35px;border-radius:50%;border:3px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">🆘</div>`,
          iconSize: [35, 35], iconAnchor: [17, 17]
        });
        const marker = window.L.marker([help.location.lat, help.location.lng], { icon: helpIcon })
          .addTo(mapInstanceRef.current).on('click', () => onHelpMarkerPress(help));
        markersRef.current.push(marker);
      });
    }
    if (bookerLocation) {
      const bookerIcon = window.L.divIcon({
        className: 'booker-marker',
        html: `<div style="background-color:#2196f3;width:20px;height:20px;border-radius:50%;border:3px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);"></div>`,
        iconSize: [20, 20], iconAnchor: [10, 10]
      });
      const bookerMarker = window.L.marker([bookerLocation.lat, bookerLocation.lng], { icon: bookerIcon })
        .addTo(mapInstanceRef.current);
      markersRef.current.push(bookerMarker);
    }
  };

  return <div ref={mapRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
}

function MobileMap({ parkings, onMarkerPress, region, onRegionChange, mapRef, bookerLocation, userCarSize, selectedParking, helpRequests, onHelpMarkerPress }) {
  const sizeOrder = ['S', 'M', 'L', 'XL'];
  const getMarkerColor = (parking) => {
    if (!userCarSize || !parking.ownerCar?.size) return '#44aa44';
    const userIdx = sizeOrder.indexOf(userCarSize);
    const parkingIdx = sizeOrder.indexOf(parking.ownerCar?.size);
    if (userIdx <= parkingIdx) return '#44aa44';
    if (userIdx === parkingIdx + 1) return '#ffaa00';
    return '#ff4444';
  };
  
  return (
    <MapView ref={mapRef} style={StyleSheet.absoluteFillObject} region={region} onRegionChangeComplete={onRegionChange} showsUserLocation={true}>
      {parkings.map(parking => {
        const isSelected = selectedParking && (selectedParking._id === parking._id || selectedParking.id === parking.id);
        return (
          <Marker key={parking._id || parking.id} coordinate={{ latitude: parking.location.lat, longitude: parking.location.lng }}
            onPress={() => onMarkerPress(parking)}>
            <View style={{ width: isSelected ? 48 : 38, height: isSelected ? 48 : 38, borderRadius: isSelected ? 24 : 19, backgroundColor: getMarkerColor(parking), borderWidth: 3, borderColor: 'white', justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: 'white', fontWeight: 'bold', fontSize: isSelected ? 14 : 12 }}>{parking.price}</Text>
            </View>
          </Marker>
        );
      })}
      {helpRequests && helpRequests.map(help => (
        <Marker key={help._id} coordinate={{ latitude: help.location.lat, longitude: help.location.lng }}
          onPress={() => onHelpMarkerPress(help)}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#ff6b6b', borderWidth: 3, borderColor: 'white', justifyContent: 'center', alignItems: 'center' }}>
            <Text style={{ fontSize: 20 }}>🆘</Text>
          </View>
        </Marker>
      ))}
      {bookerLocation && (
        <Marker coordinate={{ latitude: bookerLocation.lat, longitude: bookerLocation.lng }} title="Driver coming" pinColor="blue" />
      )}
    </MapView>
  );
}

const Avatar = ({ uri, name, size = 45 }) => (
  uri ? (
    <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  ) : (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#4a5568', justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ color: 'white', fontSize: size * 0.4, fontWeight: 'bold' }}>{name?.charAt(0)?.toUpperCase() || '?'}</Text>
    </View>
  )
);

export default function MapScreen({ user, onLogout, onUpdateUser }) {
  const mapRef = useRef(null);
  const [language, setLanguage] = useState(user.language || 'ru');
  const [allParkings, setAllParkings] = useState([]);
  const [filteredParkings, setFilteredParkings] = useState([]);
  const [selectedParking, setSelectedParking] = useState(null);
  const [myParking, setMyParking] = useState(null);
  const [myBooking, setMyBooking] = useState(null);
  const [helpRequests, setHelpRequests] = useState([]);
  const [selectedHelpRequest, setSelectedHelpRequest] = useState(null);
  const [myHelpRequest, setMyHelpRequest] = useState(null);
  const [myHelpingRequest, setMyHelpingRequest] = useState(null);
  const [showHelpingModal, setShowHelpingModal] = useState(false);
  const [messages, setMessages] = useState([]);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [lastSeenMessageCount, setLastSeenMessageCount] = useState(0);
  const [myLocation, setMyLocation] = useState(null);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showMyHelpModal, setShowMyHelpModal] = useState(false);
  const [stats, setStats] = useState({ totalUsers: 0, nearbyUsers: 0 });
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showFiltersModal, setShowFiltersModal] = useState(false);
  const [showMyParkingModal, setShowMyParkingModal] = useState(false);
  const [showMyBookingModal, setShowMyBookingModal] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [ratingData, setRatingData] = useState(null);
  const [region, setRegion] = useState({ latitude: 40.7128, longitude: -74.0060, latitudeDelta: 0.05, longitudeDelta: 0.05 });
  const [filters, setFilters] = useState({ priceRange: [1, 100], maxDistance: 5, maxTime: 60 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [localTimeLeft, setLocalTimeLeft] = useState(null);

  const L = (key) => t(key, language);

  useEffect(() => { 
    loadAll(); 
    requestLocation();
  }, []);
  
  useEffect(() => { 
    const interval = setInterval(() => {
      loadAll();
      if (myBooking && !myBooking.arrivedAt) updateMyLocation();
      if (myLocation) {
        api.updateUserLocation(user.id || user._id, myLocation);
        api.getStats(myLocation.lat, myLocation.lng).then(setStats);
      }
    }, 10000); 
    return () => clearInterval(interval); 
  }, [myBooking, myLocation]);
  
  useEffect(() => { applyFilters(); }, [allParkings, filters]);
  useEffect(() => { setLanguage(user.language || 'ru'); }, [user.language]);
  
  // Проверка туториала при первом запуске
  useEffect(() => {
    const checkTutorial = async () => {
      try {
        const seen = await AsyncStorage.getItem('tutorialSeen');
        if (!seen) {
          setShowTutorial(true);
        }
      } catch (e) {
        console.log('Tutorial check error:', e);
      }
    };
    checkTutorial();
  }, []);

  const closeTutorial = async () => {
    if (dontShowAgain) {
      try {
        await AsyncStorage.setItem('tutorialSeen', 'true');
      } catch (e) {
        console.log('Tutorial save error:', e);
      }
    }
    setShowTutorial(false);
  };
  
  // Локальный таймер для кнопки на карте
  useEffect(() => {
    if (myParking && myParking.expiresAt && myParking.status !== 'booked') {
      const updateTimer = () => {
        const remaining = Math.max(0, Math.floor((new Date(myParking.expiresAt) - new Date()) / 1000));
        setLocalTimeLeft(remaining);
      };
      updateTimer();
      const timer = setInterval(updateTimer, 1000);
      return () => clearInterval(timer);
    } else {
      setLocalTimeLeft(null);
    }
  }, [myParking]);

  // Close booking modal and show rating when deal is completed by owner
  const prevBookingRef = React.useRef(myBooking);
  useEffect(() => {
    if (prevBookingRef.current && !myBooking && showMyBookingModal) {
      const completedBooking = { ...prevBookingRef.current };
      setShowMyBookingModal(false);
      if (completedBooking && completedBooking._id) {
        setTimeout(() => {
          setRatingData({
            bookingId: completedBooking.bookingId || completedBooking._id,
            toUserId: completedBooking.ownerId?._id || completedBooking.ownerId,
            toUserName: completedBooking.ownerName || "Owner"
          });
          setShowRatingModal(true);
        }, 500);
      }
    }
    prevBookingRef.current = myBooking;
  }, [myBooking, showMyBookingModal]);

  const requestLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const location = await Location.getCurrentPositionAsync({});
      setMyLocation({ lat: location.coords.latitude, lng: location.coords.longitude });
      api.updateUserLocation(user.id || user._id, { lat: location.coords.latitude, lng: location.coords.longitude });
      setRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 });
      const statsData = await api.getStats(location.coords.latitude, location.coords.longitude);
      setStats(statsData);
    }
  };

  const updateMyLocation = async () => {
    if (!myBooking) return;
    try {
      const location = await Location.getCurrentPositionAsync({});
      const loc = { lat: location.coords.latitude, lng: location.coords.longitude };
      setMyLocation(loc);
      await api.updateBookerLocation(myBooking._id, loc);
    } catch (e) {}
  };

  const loadAll = async () => { const userId = user.id || user._id; const freshUser = await api.getUser(userId); if (freshUser && freshUser.balance !== user.balance) { onUpdateUser({ ...user, ...freshUser }); }
    const data = await api.getParkings();
    setAllParkings(data);
    
    const parking = await api.getMyParking(user.id || user._id);
    setMyParking(parking);
    
    const booking = await api.getMyBooking(user.id || user._id);
    setMyBooking(booking);
    
    if (booking) {
      const msgs = await api.getMessages(booking._id);
      setMessages(msgs);
    } else if (parking?.status === 'booked') {
      const msgs = await api.getMessages(parking._id);
      setMessages(msgs);
    }

    // Load help requests
    const helpReqs = await api.getHelpRequests(); console.log("Loaded helpReqs:", helpReqs.length, helpReqs);
    setHelpRequests(helpReqs);
    const myHelp = helpReqs.find(h => (h.userId?._id || h.userId) === userId && (h.status === 'active' || h.status === 'accepted'));
    setMyHelpRequest(myHelp || null);
    const helping = helpReqs.find(h => (h.helperId?._id || h.helperId) === userId && h.status === 'accepted');
    setMyHelpingRequest(helping || null);

    
    
    };

  const applyFilters = () => {
    setFilteredParkings(allParkings.filter(p => 
      p.price >= filters.priceRange[0] && p.price <= filters.priceRange[1] && p.timeToLeave <= filters.maxTime
    ));
  };

  const handleMarkerPress = (parking) => { 
    setSelectedParking(parking); 
    setShowBookingModal(true); 
  };
  
  const handleLocationSelect = (location) => {
    const newRegion = { latitude: location.latitude, longitude: location.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 };
    setRegion(newRegion);
    if (mapRef.current?.animateToRegion) mapRef.current.animateToRegion(newRegion, 1000);
  };

  const handleBook = async () => {
    if (!selectedParking || user.balance < selectedParking.price) {
      Alert.alert(L('error'), L('not_enough_points'));
      return;
    }
    
    const sizeCheck = checkSizeCompatibility(selectedParking.ownerCar?.size, user.car?.size, language);
    if (!sizeCheck.compatible) {
      Alert.alert(
        language === 'en' ? 'Size warning' : 'Предупреждение о размере',
        sizeCheck.warning + '\n\n' + (language === 'en' ? 'Continue anyway?' : 'Всё равно продолжить?'),
        [
          { text: L('cancel'), style: 'cancel' },
          { text: L('yes'), onPress: () => confirmBook() }
        ]
      );
      return;
    }
    
    confirmBook();
  };

  const confirmBook = async () => {
    const result = await api.bookParking(selectedParking._id || selectedParking.id, user.id || user._id);
    if (result.success) {
      Alert.alert(L('success'), L('booking_success'));
      onUpdateUser({ ...user, balance: result.newBalance });
      setShowBookingModal(false);
      loadAll();
    } else {
      Alert.alert(L('error'), result.message);
    }
  };

  const handleCreateSuccess = () => { 
    setShowCreateModal(false); 
    loadAll(); 
  };
  
  const handleExtendParking = async (parkingId, minutes) => {
    const result = await api.extendParking(parkingId, minutes);
    if (result.success) { 
      Alert.alert(L('success'), `+${minutes} ${L('minutes')}`); 
      loadAll(); 
    } else {
      Alert.alert(L('error'), result.message);
    }
  };
  
  const handleCancelParking = async (parkingId) => {
    const result = await api.cancelParking(parkingId);
    if (result.success) { 
      Alert.alert(L('success'), L('parking_cancelled'));
      setMyParking(null); 
      setShowMyParkingModal(false); 
      loadAll(); 
    }
  };

  const handleCancelWaiting = async (parkingId, ownerId, reason) => {
    const result = await api.cancelWaiting(parkingId, ownerId, reason);
    if (result.success) {
      Alert.alert(L('success'), language === 'en' ? 'Waiting cancelled' : 'Ожидание отменено');
      setMyParking(null);
      setShowMyParkingModal(false);
      loadAll();
    }
  };
  
  const handleUpdateComment = async (parkingId, comment) => { 
    await api.updateParkingComment(parkingId, comment); 
  };

  const handleSendMessage = async (text) => {
    if (!myBooking) return;
    await api.sendMessage(myBooking._id, user.id || user._id, text, false);
    const msgs = await api.getMessages(myBooking._id);
    setMessages(msgs);
  };
  
  const handleRequestWait = async (minutes) => {
    if (!myBooking) return;
    const result = await api.requestWait(myBooking._id, minutes, user.id || user._id);
    if (result.success) Alert.alert(L('success'), L('request_sent'));
  };

  const handleRespondWait = async (accepted) => {
    if (!myBooking) return;
    const result = await api.respondWaitRequest(myBooking._id, accepted);
    if (result.success) {
      if (!accepted) {
        Alert.alert(L("success"), language === "en" ? "Owner notified" : "Владелец уведомлён");
      }
      loadAll();
    }
  };
  
  const handleCancelBooking = async (reason) => {
    if (!myBooking) return;
    const result = await api.cancelBooking(myBooking._id, user.id || user._id, reason);
    if (result.success) {
      Alert.alert(L('success'), L('booking_cancelled'));
      setMyBooking(null);
      setShowMyBookingModal(false);
      loadAll();
    }
  };

  const handleArrived = async () => {
    if (!myBooking) return;
    const result = await api.markArrived(myBooking._id);
    if (result.success) {
      Alert.alert(L('success'), language === 'en' ? 'Owner notified!' : 'Владелец уведомлён!');
      loadAll();
    }
  };

  // Вижу тебя - завершение сделки
  const handleConfirmMeet = async (parkingId) => {
    const parkingData = myParking;
    const result = await api.confirmMeet(parkingId);
    if (result.success) {
      setMyParking(null);
      setShowMyParkingModal(false);
      loadAll();
      
      // Show rating modal after deal completion
      if (parkingData && parkingData.bookedBy) {
        setTimeout(() => {
          setRatingData({
            bookingId: result.bookingId,
            toUserId: parkingData.bookedBy._id || parkingData.bookedBy,
            toUserName: parkingData.bookerName || 'Driver'
          });
          setShowRatingModal(true);
        }, 500);
      } else {
        Alert.alert('🎉 Done!', 'Deal completed successfully!');
      }
    }
  };

  const handleFloatingButtonPress = () => {
    if (myBooking) { setShowMyBookingModal(true); setLastSeenMessageCount(messages.length); }
    else if (myParking) { setShowMyParkingModal(true); setLastSeenMessageCount(messages.length); }
    else setShowCreateModal(true);
  };

  const formatTime = (min) => min >= 60 ? `${Math.floor(min/60)}${L('hour_short')} ${min%60}${L('min_short')}` : `${min}${L('min_short')}`;
  
  const formatTimeWithSeconds = (totalSeconds) => {
    const min = Math.floor(totalSeconds / 60);
    const sec = totalSeconds % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };
  
  const activeFiltersCount = [filters.priceRange[1] !== 100, filters.maxDistance !== 5, filters.maxTime !== 60].filter(Boolean).length;

  const getButtonState = () => {
    if (myBooking) {
      if (myBooking.arrivedAt) return { color: '#4caf50', text: `✅ ${language === 'en' ? 'Arrived' : 'На месте'}`, subtext: language === 'en' ? 'Waiting for owner' : 'Ожидаем владельца' };
      return { color: '#2196f3', text: `🚗 ${L('going_to_parking')}`, subtext: myBooking.address?.split(',')[0] };
    }
    if (myParking) {
      if (myParking.status === 'booked') {
        if (myParking.arrivedAt) return { color: '#4caf50', text: `📍 ${language === 'en' ? 'Driver here!' : 'Водитель здесь!'}`, subtext: language === 'en' ? 'Tap to confirm' : 'Нажмите для подтверждения' };
        return { color: '#4caf50', text: `✅ ${L('booked')}`, subtext: L('waiting_for_you') };
      }
      // Используем локальный таймер с секундами
      const timeDisplay = localTimeLeft !== null ? formatTimeWithSeconds(localTimeLeft) : formatTime(myParking.timeToLeave);
      return { color: '#4caf50', text: `⏱️ ${timeDisplay}`, subtext: L('my_parking') };
    }
    return { color: '#4a5568', text: `🚗 ${L('im_leaving')}`, subtext: null };
  };

  const buttonState = getButtonState();
  const bookerLocation = myParking?.status === 'booked' ? myParking.bookerLocation : null;

  const formatCar = (car) => {
    if (!car) return '';
    return `${car.color || ''} ${car.brand || ''} ${car.model || ''}`.trim();
  };


  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setShowProfileModal(true)}>
          <Avatar uri={user.avatar} name={user.name} size={45} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.greeting}>{L('hello')}, {user.name}! 👋</Text>
          <Text style={styles.balance}>💰 {user.balance} {L('points')}</Text>
        </View>
        <View style={styles.headerRight}>
          {user.isAdmin && (
            <TouchableOpacity onPress={() => setShowAdminModal(true)} style={styles.adminBtn}>
              <Text style={styles.adminBtnText}>🔧</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onLogout}>
            <Text style={styles.logoutText}>{L('logout')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search */}
      <SearchBar onLocationSelect={handleLocationSelect} language={language} />

      {/* Stats Block */}
      <View style={styles.statsBlock}>
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.totalUsers}</Text>
          <Text style={styles.statLabel}>{L('total_users')}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.nearbyUsers}</Text>
          <Text style={styles.statLabel}>{L('nearby_users')}</Text>
        </View>
      </View>

      {/* Map */}
      {Platform.OS === 'web' ? (
        <WebMap parkings={filteredParkings} onMarkerPress={handleMarkerPress} region={region} bookerLocation={bookerLocation} userCarSize={user.car?.size} helpRequests={helpRequests} onHelpMarkerPress={(h) => setSelectedHelpRequest(h)} />
      ) : (
        <MobileMap parkings={filteredParkings} onMarkerPress={handleMarkerPress} region={region} onRegionChange={setRegion} mapRef={mapRef} bookerLocation={bookerLocation} userCarSize={user.car?.size} selectedParking={selectedParking} helpRequests={helpRequests} onHelpMarkerPress={(h) => setSelectedHelpRequest(h)} />
      )}

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#44aa44' }]} /><Text style={styles.legendText}>{L('size_fits')}</Text></View>
        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#ffaa00' }]} /><Text style={styles.legendText}>{L('size_too_small')}</Text></View>
        <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#ff4444' }]} /><Text style={styles.legendText}>{L('size_too_big')}</Text></View>
      </View>

      {/* Floating Button */}
      <TouchableOpacity style={[styles.floatingButton, { backgroundColor: buttonState.color }]} onPress={handleFloatingButtonPress}>
        <Text style={styles.floatingButtonText}>{buttonState.text}</Text>
        {buttonState.subtext && <Text style={styles.floatingButtonSubtext}>{buttonState.subtext}</Text>}
        {messages.length > lastSeenMessageCount && (myParking?.status === "booked" || myBooking) && (
          <View style={styles.messageBadge}><Text style={styles.messageBadgeText}>{messages.length - lastSeenMessageCount}</Text></View>
        )}
      </TouchableOpacity>


      {/* SOS Button */}
      {!myParking && !myBooking && !myHelpRequest && (
        <TouchableOpacity style={styles.sosButton} onPress={() => setShowHelpModal(true)}>
          <Text style={styles.sosButtonText}>🆘</Text>
        </TouchableOpacity>
      )}

      {/* My Help Request Button */}
      {myHelpRequest && (
        <TouchableOpacity style={[styles.sosButton, { backgroundColor: '#ff9800' }]} onPress={() => setShowMyHelpModal(true)}>
          <Text style={styles.sosButtonText}>🆘</Text>
        </TouchableOpacity>
      )}

      {/* Im Helping Button */}
      {myHelpingRequest && (
        <TouchableOpacity style={[styles.sosButton, { backgroundColor: '#4caf50' }]} onPress={() => setShowHelpingModal(true)}>
          <Text style={styles.sosButtonText}>🤝</Text>
        </TouchableOpacity>
      )}      
      {/* Booking Modal */}
      <Modal visible={showBookingModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedParking && (
              <>
                <Text style={styles.modalTitle}>🅿️ {L('parking')}</Text>
                <Text style={styles.modalAddress}>{selectedParking.address}</Text>
                
                {/* Owner card with avatar */}
                <View style={styles.ownerCard}>
                  <Avatar uri={selectedParking.ownerAvatar} name={selectedParking.ownerId?.name} size={40} />
                  <View style={styles.ownerInfo}>
                    <Text style={styles.ownerName}>{selectedParking.ownerId?.name || 'Owner'}</Text>
                    <Text style={styles.ownerCarText}>{formatCar(selectedParking.ownerCar)}</Text>
                  </View>
                  {selectedParking.ownerCar?.size && (
                    <View style={[styles.sizeBadge, { backgroundColor: getSizeColor(selectedParking.ownerCar.size) }]}>
                      <Text style={styles.sizeBadgeText}>{selectedParking.ownerCar.size}</Text>
                    </View>
                  )}
                </View>

                {/* Size compatibility warning */}
                {user.car?.size && selectedParking.ownerCar?.size && (
                  (() => {
                    const check = checkSizeCompatibility(selectedParking.ownerCar.size, user.car.size, language);
                    if (check.warning) {
                      return (
                        <View style={[styles.warningBox, !check.compatible && styles.warningBoxDanger]}>
                          <Text style={styles.warningText}>⚠️ {check.warning}</Text>
                        </View>
                      );
                    }
                    return null;
                  })()
                )}
                
                {selectedParking.comment && (
                  <View style={styles.commentBox}>
                    <Text style={styles.commentLabel}>💬 {L('from_owner')}:</Text>
                    <Text style={styles.commentText}>{selectedParking.comment}</Text>
                  </View>
                )}
                
                <View style={styles.modalInfo}>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>💰 {L('price')}:</Text>
                    <Text style={styles.infoValue}>{selectedParking.price} {L('points')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>⏱️ {L('time_left')}:</Text>
                    <Text style={styles.infoValue}>{selectedParking.timeToLeave} {L('minutes')}</Text>
                  </View>
                </View>
                
                <TouchableOpacity style={styles.bookButton} onPress={handleBook}>
                  <Text style={styles.bookButtonText}>{L('book')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelButton} onPress={() => { setShowBookingModal(false); setSelectedParking(null); }}>
                  <Text style={styles.cancelButtonText}>{L('cancel')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Create Modal */}
      <Modal visible={showCreateModal} transparent animationType="slide">
        <CreateParkingScreen user={user} onClose={() => setShowCreateModal(false)} onSuccess={handleCreateSuccess} language={language} />
      </Modal>

      {/* Profile Modal */}
      <Modal visible={showProfileModal} animationType="slide">
        <ProfileScreen user={user} onClose={() => setShowProfileModal(false)} onUpdateUser={onUpdateUser} language={language} />
      </Modal>

      {/* Filters Modal */}
      <FiltersModal visible={showFiltersModal} onClose={() => setShowFiltersModal(false)} onApply={setFilters} currentFilters={filters} language={language} />

      {/* My Parking Modal */}
      <Modal visible={showMyParkingModal} transparent animationType="slide">
        {myParking && (
          <MyParkingStatusScreen 
            parking={myParking} 
            user={user}
            onClose={() => setShowMyParkingModal(false)} 
            onExtend={handleExtendParking} 
            onCancel={handleCancelParking} 
            onCancelWaiting={handleCancelWaiting}
            onUpdateComment={handleUpdateComment}
            onConfirmMeet={handleConfirmMeet}
            onUpdateUser={onUpdateUser}
            language={language}
          />
        )}
      </Modal>

      {/* My Booking Modal */}
      <Modal visible={showMyBookingModal} transparent animationType="slide">
        {myBooking && (
          <MyBookingStatusScreen 
            booking={myBooking}
            user={user}
            onClose={() => setShowMyBookingModal(false)} 
            onSendMessage={handleSendMessage} 
            onRequestWait={handleRequestWait} 
            onCancelBooking={handleCancelBooking}
            onRespondWait={handleRespondWait}
            onArrived={handleArrived}
            onUpdateUser={onUpdateUser}
            messages={messages}
            language={language}
          />
        )}
      </Modal>

      {/* Admin Modal */}
      <Modal visible={showAdminModal} animationType="slide">
        <AdminScreen user={user} onClose={() => setShowAdminModal(false)} language={language} />
      </Modal>

      {/* Help Request Modal */}
      <Modal visible={showHelpModal} animationType="slide">
        <CreateHelpRequestScreen user={user} onClose={() => setShowHelpModal(false)} onSuccess={() => loadAll()} language={language} />
      </Modal>


      {/* View Help Request Modal */}
      <Modal visible={!!selectedHelpRequest} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>🆘 {L('roadside_assistance')}</Text>
            {selectedHelpRequest && (
              <>
                <Text style={styles.modalAddress}>📍 {selectedHelpRequest.address}</Text>
                <View style={styles.ownerCard}>
                  <View style={styles.ownerInfo}>
                    <Text style={styles.ownerName}>{selectedHelpRequest.userId?.name || 'User'}</Text>
                    <Text style={styles.ownerCarText}>{L(selectedHelpRequest.problemType)}</Text>
                  </View>
                </View>
                {selectedHelpRequest.description && (
                  <View style={styles.commentBox}>
                    <Text style={styles.commentText}>{selectedHelpRequest.description}</Text>
                  </View>
                )}
                <View style={styles.modalInfo}>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>💰 {L('reward')}:</Text>
                    <Text style={styles.infoValue}>{selectedHelpRequest.reward} {L('points')}</Text>
                  </View>
                </View>
                {(selectedHelpRequest.userId?._id || selectedHelpRequest.userId) !== (user._id || user.id) && (
                <TouchableOpacity style={styles.bookButton} onPress={async () => {
                  const result = await api.acceptHelpRequest(selectedHelpRequest._id, user._id || user.id);
                  if (result.success) { Alert.alert(L('success'), L('help_on_the_way')); setSelectedHelpRequest(null); loadAll(); }
                }}>
                  <Text style={styles.bookButtonText}>🤝 {L('i_can_help')}</Text>
                </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.cancelButton} onPress={() => setSelectedHelpRequest(null)}>
                  <Text style={styles.cancelButtonText}>{L('cancel')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
      {/* Rating Modal */}


      {/* My Help Request Modal */}
      <Modal visible={showMyHelpModal} animationType="slide">
        {myHelpRequest && (
          <HelpStatusScreen
            helpRequest={myHelpRequest}
            user={user}
            onClose={() => setShowMyHelpModal(false)}
            onUpdate={loadAll}
            language={language}
            isHelper={false}
          />
        )}
      </Modal>

      {/* Im Helping Modal */}
      <Modal visible={showHelpingModal} animationType="slide">
        {myHelpingRequest && (
          <HelpStatusScreen
            helpRequest={myHelpingRequest}
            user={user}
            onClose={() => setShowHelpingModal(false)}
            onUpdate={loadAll}
            language={language}
            isHelper={true}
          />
        )}
      </Modal>
      {ratingData && (
        <RatingModal
          visible={showRatingModal}
          onClose={() => {
            setShowRatingModal(false);
            setRatingData(null);
          }}
          bookingId={ratingData.bookingId}
          fromUserId={user.id || user._id || user._id}
          toUserId={ratingData.toUserId}
          toUserName={ratingData.toUserName}
          language={language}
        />
      )}

      {/* Tutorial Modal */}
      <Modal visible={showTutorial} animationType="fade" transparent>
        <View style={styles.tutorialOverlay}>
          <View style={styles.tutorialContent}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.tutorialTitle}>
                {language === 'ru' ? '👋 Добро пожаловать в ParkBro!' : 
                 language === 'es' ? '👋 ¡Bienvenido a ParkBro!' : 
                 language === 'uk' ? '👋 Ласкаво просимо до ParkBro!' : 
                 '👋 Welcome to ParkBro!'}
              </Text>
              
              <View style={styles.tutorialHighlight}>
                <Text style={styles.tutorialHighlightTitle}>
                  {language === 'ru' ? '🌟 Помогайте сообществу!' : 
                   language === 'es' ? '🌟 ¡Ayuda a la comunidad!' : 
                   language === 'uk' ? '🌟 Допомагайте спільноті!' : 
                   '🌟 Help the community!'}
                </Text>
                <Text style={styles.tutorialHighlightText}>
                  {language === 'ru' ? 'Уезжая с парковки в загруженных местах, отмечайте своё место — так другие водители смогут быстрее найти парковку, а вы заработаете баллы!' : 
                   language === 'es' ? 'Al salir de un estacionamiento en áreas concurridas, marca tu lugar — ¡otros conductores encontrarán estacionamiento más rápido y tú ganarás puntos!' : 
                   language === 'uk' ? 'Виїжджаючи з парковки в завантажених місцях, відмічайте своє місце — так інші водії зможуть швидше знайти парковку, а ви заробите бали!' : 
                   'When leaving a parking spot in busy areas, mark your spot — other drivers will find parking faster and you\'ll earn points!'}
                </Text>
              </View>

              <Text style={styles.tutorialSectionTitle}>
                {language === 'ru' ? '📱 Как это работает:' : 
                 language === 'es' ? '📱 Cómo funciona:' : 
                 language === 'uk' ? '📱 Як це працює:' : 
                 '📱 How it works:'}
              </Text>

              <View style={styles.tutorialStep}>
                <Text style={styles.tutorialStepNumber}>1</Text>
                <View style={styles.tutorialStepContent}>
                  <Text style={styles.tutorialStepTitle}>
                    {language === 'ru' ? '🚗 Уезжаете?' : 
                     language === 'es' ? '🚗 ¿Te vas?' : 
                     language === 'uk' ? '🚗 Виїжджаєте?' : 
                     '🚗 Leaving?'}
                  </Text>
                  <Text style={styles.tutorialStepText}>
                    {language === 'ru' ? 'Нажмите "Я уезжаю", укажите время и цену. Другие водители увидят ваше место на карте.' : 
                     language === 'es' ? 'Presiona "Me voy", indica tiempo y precio. Otros conductores verán tu lugar en el mapa.' : 
                     language === 'uk' ? 'Натисніть "Я виїжджаю", вкажіть час і ціну. Інші водії побачать ваше місце на карті.' : 
                     'Tap "I\'m Leaving", set time and price. Other drivers will see your spot on the map.'}
                  </Text>
                </View>
              </View>

              <View style={styles.tutorialStep}>
                <Text style={styles.tutorialStepNumber}>2</Text>
                <View style={styles.tutorialStepContent}>
                  <Text style={styles.tutorialStepTitle}>
                    {language === 'ru' ? '🅿️ Ищете парковку?' : 
                     language === 'es' ? '🅿️ ¿Buscas estacionamiento?' : 
                     language === 'uk' ? '🅿️ Шукаєте парковку?' : 
                     '🅿️ Need parking?'}
                  </Text>
                  <Text style={styles.tutorialStepText}>
                    {language === 'ru' ? 'Смотрите зелёные маркеры на карте — это свободные места. Нажмите, чтобы забронировать.' : 
                     language === 'es' ? 'Mira los marcadores verdes en el mapa — son lugares disponibles. Toca para reservar.' : 
                     language === 'uk' ? 'Дивіться зелені маркери на карті — це вільні місця. Натисніть, щоб забронювати.' : 
                     'Look for green markers on the map — those are available spots. Tap to book.'}
                  </Text>
                </View>
              </View>

              <View style={styles.tutorialStep}>
                <Text style={styles.tutorialStepNumber}>3</Text>
                <View style={styles.tutorialStepContent}>
                  <Text style={styles.tutorialStepTitle}>
                    {language === 'ru' ? '💎 Зарабатывайте баллы' : 
                     language === 'es' ? '💎 Gana puntos' : 
                     language === 'uk' ? '💎 Заробляйте бали' : 
                     '💎 Earn points'}
                  </Text>
                  <Text style={styles.tutorialStepText}>
                    {language === 'ru' ? 'Отдавая место — получаете баллы. Тратьте их на бронирование, помощь на дороге и товары в магазине!' : 
                     language === 'es' ? 'Al ceder tu lugar — ganas puntos. ¡Úsalos para reservar, asistencia en carretera y productos!' : 
                     language === 'uk' ? 'Віддаючи місце — отримуєте бали. Витрачайте їх на бронювання, допомогу на дорозі та товари в магазині!' : 
                     'Give up your spot — earn points. Spend them on bookings, roadside help and shop items!'}
                  </Text>
                </View>
              </View>

              <View style={styles.tutorialStep}>
                <Text style={styles.tutorialStepNumber}>4</Text>
                <View style={styles.tutorialStepContent}>
                  <Text style={styles.tutorialStepTitle}>
                    {language === 'ru' ? '🆘 Нужна помощь?' : 
                     language === 'es' ? '🆘 ¿Necesitas ayuda?' : 
                     language === 'uk' ? '🆘 Потрібна допомога?' : 
                     '🆘 Need help?'}
                  </Text>
                  <Text style={styles.tutorialStepText}>
                    {language === 'ru' ? 'Спустило колесо? Сел аккумулятор? Нажмите SOS — водители рядом придут на помощь!' : 
                     language === 'es' ? '¿Neumático pinchado? ¿Batería agotada? ¡Presiona SOS — conductores cercanos vendrán a ayudar!' : 
                     language === 'uk' ? 'Спустило колесо? Сів акумулятор? Натисніть SOS — водії поруч прийдуть на допомогу!' : 
                     'Flat tire? Dead battery? Tap SOS — nearby drivers will come to help!'}
                  </Text>
                </View>
              </View>

              <TouchableOpacity 
                style={styles.tutorialCheckbox} 
                onPress={() => setDontShowAgain(!dontShowAgain)}
              >
                <View style={[styles.checkbox, dontShowAgain && styles.checkboxChecked]}>
                  {dontShowAgain && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={styles.checkboxLabel}>
                  {language === 'ru' ? 'Больше не показывать' : 
                   language === 'es' ? 'No mostrar de nuevo' : 
                   language === 'uk' ? 'Більше не показувати' : 
                   'Don\'t show again'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.tutorialButton} onPress={closeTutorial}>
                <Text style={styles.tutorialButtonText}>
                  {language === 'ru' ? 'Понятно, начать!' : 
                   language === 'es' ? '¡Entendido, empezar!' : 
                   language === 'uk' ? 'Зрозуміло, почати!' : 
                   'Got it, let\'s go!'}
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0' },
  header: { 
    position: 'absolute', top: 50, left: 15, right: 15, zIndex: 1000,
    backgroundColor: 'white', borderRadius: 15, padding: 12,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25, shadowRadius: 8, elevation: 5
  },
  headerCenter: { flex: 1, marginLeft: 12 },
  greeting: { fontSize: 14, color: '#333' },
  balance: { fontSize: 18, fontWeight: 'bold', color: '#4a5568', marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  adminBtn: { padding: 5 },
  adminBtnText: { fontSize: 20 },
  logoutText: { color: '#ff4444', fontWeight: '600', fontSize: 13, padding: 8 },
  filterButton: { 
    position: 'absolute', top: 175, left: 15, zIndex: 1000,
    backgroundColor: 'white', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 3
  },
  filterButtonText: { fontSize: 13, color: '#333', fontWeight: '600' },
  filterBadge: { backgroundColor: '#4a5568', borderRadius: 10, width: 18, height: 18, justifyContent: 'center', alignItems: 'center', marginLeft: 6 },
  filterBadgeText: { color: 'white', fontSize: 11, fontWeight: 'bold' },
  countBadge: { 
    position: 'absolute', top: 175, right: 15, zIndex: 1000,
    backgroundColor: 'white', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 3
  },
  countText: { fontSize: 13, color: '#666' },
  statsBlock: { position: 'absolute', top: 175, left: 15, right: 15, zIndex: 999, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 12, padding: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3 },
  statItem: { flex: 1, alignItems: 'center' },
  statNumber: { fontSize: 20, fontWeight: 'bold', color: '#4a5568' },
  statLabel: { fontSize: 11, color: '#888', marginTop: 2 },
  statDivider: { width: 1, height: 30, backgroundColor: '#ddd' },
  legend: { 
    position: 'absolute', bottom: 110, left: 15, zIndex: 1000,
    backgroundColor: 'white', borderRadius: 10, padding: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  legendDot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  legendText: { fontSize: 12, color: '#666' },
  floatingButton: { 
    position: 'absolute', bottom: 30, alignSelf: 'center', zIndex: 1000, 
    borderRadius: 25, paddingVertical: 12, paddingHorizontal: 25,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8, 
    alignItems: 'center'
  },
  floatingButtonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  floatingButtonSubtext: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 2 },
  messageBadge: { position: "absolute", top: -5, right: -5, backgroundColor: "#ff3b30", borderRadius: 12, minWidth: 24, height: 24, justifyContent: "center", alignItems: "center", paddingHorizontal: 6 },
  sosButton: { position: 'absolute', bottom: 118, right: 20, width: 55, height: 55, borderRadius: 28, backgroundColor: '#ff6b6b', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  sosButtonText: { fontSize: 24 },
  messageBadgeText: { color: "white", fontSize: 12, fontWeight: "bold" },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: 'white', borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 25 },
  modalTitle: { fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  modalAddress: { fontSize: 16, color: '#666', textAlign: 'center', marginTop: 5, marginBottom: 15 },
  ownerCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8f9fa', borderRadius: 12, padding: 12, marginBottom: 15 },
  ownerInfo: { flex: 1, marginLeft: 12 },
  ownerName: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  ownerCarText: { fontSize: 13, color: '#666', marginTop: 2 },
  sizeBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  sizeBadgeText: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  warningBox: { backgroundColor: '#fff3e0', borderRadius: 10, padding: 10, marginBottom: 15, borderLeftWidth: 4, borderLeftColor: '#ff9800' },
  warningBoxDanger: { backgroundColor: '#ffebee', borderLeftColor: '#f44336' },
  warningText: { color: '#333', fontSize: 13 },
  commentBox: { backgroundColor: '#f0f4ff', borderRadius: 12, padding: 12, marginBottom: 15 },
  commentLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  commentText: { fontSize: 14, color: '#333' },
  modalInfo: { backgroundColor: '#f5f5f5', borderRadius: 15, padding: 15, marginBottom: 20 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  infoLabel: { fontSize: 16, color: '#666' },
  infoValue: { fontSize: 16, fontWeight: '600', color: '#333' },
  bookButton: { backgroundColor: '#4a5568', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 10 },
  bookButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  cancelButton: { padding: 16, alignItems: 'center' },
  cancelButtonText: { color: '#666', fontSize: 16 },
  // Tutorial styles
  tutorialOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  tutorialContent: { backgroundColor: 'white', borderRadius: 20, padding: 25, maxHeight: '90%', width: '100%' },
  tutorialTitle: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', color: '#333', marginBottom: 20 },
  tutorialHighlight: { backgroundColor: '#e8f5e9', borderRadius: 15, padding: 15, marginBottom: 20, borderLeftWidth: 4, borderLeftColor: '#4caf50' },
  tutorialHighlightTitle: { fontSize: 16, fontWeight: 'bold', color: '#2e7d32', marginBottom: 8 },
  tutorialHighlightText: { fontSize: 14, color: '#333', lineHeight: 20 },
  tutorialSectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 15 },
  tutorialStep: { flexDirection: 'row', marginBottom: 15, alignItems: 'flex-start' },
  tutorialStepNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#4a5568', color: 'white', textAlign: 'center', lineHeight: 28, fontSize: 14, fontWeight: 'bold', marginRight: 12 },
  tutorialStepContent: { flex: 1 },
  tutorialStepTitle: { fontSize: 15, fontWeight: 'bold', color: '#333', marginBottom: 4 },
  tutorialStepText: { fontSize: 13, color: '#666', lineHeight: 18 },
  tutorialCheckbox: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 15 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#4a5568', marginRight: 10, justifyContent: 'center', alignItems: 'center' },
  checkboxChecked: { backgroundColor: '#4a5568' },
  checkmark: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  checkboxLabel: { fontSize: 14, color: '#666' },
  tutorialButton: { backgroundColor: '#4a5568', borderRadius: 12, padding: 16, alignItems: 'center' },
  tutorialButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold' }
});

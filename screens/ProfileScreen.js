import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert, Image, Modal, RefreshControl, Share, Clipboard, Linking
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../services/api';
import { t, languages } from '../i18n/translations';
import { carBrands, getModels, getCarSize, getSizeLabel, getSizeColor, generateYears } from '../data/carDatabase';

// Terms of Service
const termsContent = {
  en: {
    title: "Terms of Service",
    sections: [
      { heading: "1. Acceptance of Terms", text: "By downloading, installing, or using the ParkBro application (\"App\"), you agree to be bound by these Terms of Service. ParkBro is operated by ParkBro LLC." },
      { heading: "2. Description of Service", text: "ParkBro is a peer-to-peer platform that connects drivers to share information about available public parking spaces and roadside assistance." },
      { heading: "3. Points System", text: "Points are NOT currency, money, or legal tender. Points have NO cash value and cannot be exchanged for cash. Points are non-transferable outside the App and may expire after 12 months of inactivity." },
      { heading: "4. Purchases and Refunds", text: "In-app purchases are processed through Apple App Store. All purchases are final and non-refundable, except as required by law." },
      { heading: "5. User Responsibilities", text: "You agree to provide accurate information, follow local traffic laws, drive safely, and not use the App for illegal purposes." },
      { heading: "6. Limitation of Liability", text: "THE APP IS PROVIDED \"AS IS\". We are not liable for parking tickets, vehicle damage, personal injury, or loss of Points due to technical issues." },
      { heading: "7. Governing Law", text: "These Terms are governed by the laws of the State of New York, United States." },
      { heading: "8. Contact", text: "Email: c110ko30rus@gmail.com" }
    ]
  },
  ru: {
    title: "Условия использования",
    sections: [
      { heading: "1. Принятие условий", text: "Загружая или используя приложение ParkBro, вы соглашаетесь с настоящими Условиями. ParkBro управляется компанией ParkBro LLC." },
      { heading: "2. Описание сервиса", text: "ParkBro — это P2P-платформа для обмена информацией о парковочных местах и помощи на дороге." },
      { heading: "3. Система баллов", text: "Баллы НЕ являются деньгами. Баллы не имеют денежной стоимости и не могут быть обменяны на деньги. Баллы могут истечь после 12 месяцев неактивности." },
      { heading: "4. Покупки и возвраты", text: "Покупки обрабатываются через Apple App Store. Все покупки окончательны и не подлежат возврату." },
      { heading: "5. Обязанности пользователя", text: "Вы соглашаетесь предоставлять точную информацию, соблюдать ПДД и не использовать приложение в незаконных целях." },
      { heading: "6. Ограничение ответственности", text: "ПРИЛОЖЕНИЕ ПРЕДОСТАВЛЯЕТСЯ «КАК ЕСТЬ». Мы не несём ответственности за штрафы, повреждения или потерю баллов." },
      { heading: "7. Применимое право", text: "Условия регулируются законодательством штата Нью-Йорк, США." },
      { heading: "8. Контакты", text: "Email: c110ko30rus@gmail.com" }
    ]
  },
  uk: {
    title: "Умови використання",
    sections: [
      { heading: "1. Прийняття умов", text: "Завантажуючи або використовуючи додаток ParkBro, ви погоджуєтесь з цими Умовами. ParkBro керується ParkBro LLC." },
      { heading: "2. Опис сервісу", text: "ParkBro — це P2P-платформа для обміну інформацією про паркувальні місця та допомогу на дорозі." },
      { heading: "3. Система балів", text: "Бали НЕ є грошима. Бали не мають грошової вартості. Бали можуть закінчитися після 12 місяців неактивності." },
      { heading: "4. Покупки та повернення", text: "Покупки обробляються через Apple App Store. Усі покупки остаточні." },
      { heading: "5. Обов'язки користувача", text: "Ви погоджуєтесь надавати точну інформацію та дотримуватися ПДР." },
      { heading: "6. Обмеження відповідальності", text: "ДОДАТОК НАДАЄТЬСЯ «ЯК Є». Ми не несемо відповідальності за штрафи або втрату балів." },
      { heading: "7. Застосовне право", text: "Умови регулюються законодавством штату Нью-Йорк, США." },
      { heading: "8. Контакти", text: "Email: c110ko30rus@gmail.com" }
    ]
  },
  es: {
    title: "Términos de Servicio",
    sections: [
      { heading: "1. Aceptación", text: "Al usar ParkBro, acepta estos Términos. ParkBro es operado por ParkBro LLC." },
      { heading: "2. Descripción", text: "ParkBro es una plataforma P2P para compartir información sobre estacionamiento y asistencia en carretera." },
      { heading: "3. Sistema de Puntos", text: "Los Puntos NO son dinero. No tienen valor en efectivo. Pueden expirar después de 12 meses de inactividad." },
      { heading: "4. Compras", text: "Las compras se procesan a través de Apple App Store. Todas las compras son finales." },
      { heading: "5. Responsabilidades", text: "Usted acepta proporcionar información precisa y cumplir con las leyes de tránsito." },
      { heading: "6. Limitación", text: "LA APLICACIÓN SE PROPORCIONA \"TAL CUAL\". No somos responsables de multas o pérdida de Puntos." },
      { heading: "7. Ley Aplicable", text: "Estos Términos se rigen por las leyes del Estado de New York, EE.UU." },
      { heading: "8. Contacto", text: "Email: c110ko30rus@gmail.com" }
    ]
  }
};

// Privacy Policy
const privacyContent = {
  en: {
    title: "Privacy Policy",
    sections: [
      { heading: "1. Information We Collect", text: "Account data (name, email), vehicle info, location data, transaction history, profile photo." },
      { heading: "2. How We Use It", text: "To provide services, process parking exchanges, send notifications, prevent fraud, and comply with laws." },
      { heading: "3. Location Data", text: "We collect GPS location when you use parking features. You can disable it in settings, but the app won't work properly." },
      { heading: "4. Data Sharing", text: "We do NOT sell your data. We share limited info with other users during exchanges and with Apple for payments." },
      { heading: "5. Data Security", text: "We use encryption (HTTPS) and secure password storage. No system is 100% secure." },
      { heading: "6. Your Rights", text: "You can access, correct, delete your data, or export it. Contact: c110ko30rus@gmail.com" },
      { heading: "7. Children", text: "The App is not for users under 16. We don't knowingly collect data from children." },
      { heading: "8. Contact", text: "ParkBro LLC\nEmail: c110ko30rus@gmail.com\nNew York, USA" }
    ]
  },
  ru: {
    title: "Политика конфиденциальности",
    sections: [
      { heading: "1. Какие данные собираем", text: "Данные аккаунта (имя, email), информация об авто, геолокация, история транзакций, фото профиля." },
      { heading: "2. Как используем", text: "Для предоставления услуг, обработки обменов парковками, отправки уведомлений, предотвращения мошенничества." },
      { heading: "3. Геолокация", text: "Мы собираем GPS при использовании функций парковки. Можно отключить в настройках, но приложение не будет работать." },
      { heading: "4. Передача данных", text: "Мы НЕ продаём ваши данные. Передаём ограниченную информацию другим пользователям и Apple для платежей." },
      { heading: "5. Безопасность", text: "Используем шифрование (HTTPS) и безопасное хранение паролей." },
      { heading: "6. Ваши права", text: "Вы можете получить доступ, исправить, удалить или экспортировать данные. Email: c110ko30rus@gmail.com" },
      { heading: "7. Дети", text: "Приложение не для пользователей младше 16 лет." },
      { heading: "8. Контакты", text: "ParkBro LLC\nEmail: c110ko30rus@gmail.com\nНью-Йорк, США" }
    ]
  },
  uk: {
    title: "Політика конфіденційності",
    sections: [
      { heading: "1. Які дані збираємо", text: "Дані облікового запису (ім'я, email), інформація про авто, геолокація, історія транзакцій, фото профілю." },
      { heading: "2. Як використовуємо", text: "Для надання послуг, обробки обмінів парковками, надсилання сповіщень, запобігання шахрайству." },
      { heading: "3. Геолокація", text: "Ми збираємо GPS при використанні функцій паркування. Можна вимкнути в налаштуваннях." },
      { heading: "4. Передача даних", text: "Ми НЕ продаємо ваші дані. Передаємо обмежену інформацію іншим користувачам та Apple для платежів." },
      { heading: "5. Безпека", text: "Використовуємо шифрування (HTTPS) та безпечне зберігання паролів." },
      { heading: "6. Ваші права", text: "Ви можете отримати доступ, виправити, видалити або експортувати дані. Email: c110ko30rus@gmail.com" },
      { heading: "7. Діти", text: "Додаток не для користувачів молодше 16 років." },
      { heading: "8. Контакти", text: "ParkBro LLC\nEmail: c110ko30rus@gmail.com\nНью-Йорк, США" }
    ]
  },
  es: {
    title: "Política de Privacidad",
    sections: [
      { heading: "1. Datos que Recopilamos", text: "Datos de cuenta (nombre, email), info del vehículo, ubicación, historial de transacciones, foto de perfil." },
      { heading: "2. Cómo los Usamos", text: "Para proporcionar servicios, procesar intercambios, enviar notificaciones, prevenir fraude." },
      { heading: "3. Ubicación", text: "Recopilamos GPS al usar funciones de estacionamiento. Puede desactivarlo en configuración." },
      { heading: "4. Compartir Datos", text: "NO vendemos sus datos. Compartimos info limitada con otros usuarios y Apple para pagos." },
      { heading: "5. Seguridad", text: "Usamos encriptación (HTTPS) y almacenamiento seguro de contraseñas." },
      { heading: "6. Sus Derechos", text: "Puede acceder, corregir, eliminar o exportar sus datos. Email: c110ko30rus@gmail.com" },
      { heading: "7. Menores", text: "La App no es para menores de 16 años." },
      { heading: "8. Contacto", text: "ParkBro LLC\nEmail: c110ko30rus@gmail.com\nNew York, EE.UU." }
    ]
  }
};

export default function ProfileScreen({ user, onClose, onUpdateUser, language }) {
  const [car, setCar] = useState(user.car || {});
  const [avatar, setAvatar] = useState(user.avatar);
  const [currentLang, setCurrentLang] = useState(language || user.language || 'ru');
  const [history, setHistory] = useState([]);
  const [myReviews, setMyReviews] = useState([]);
  const [showBrandPicker, setShowBrandPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [aboutTab, setAboutTab] = useState('terms'); // 'terms' or 'privacy'
  const [aboutLang, setAboutLang] = useState(language || 'en');
  const [availableModels, setAvailableModels] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showReviews, setShowReviews] = useState(false);

  useEffect(() => { loadHistory(); }, []);
  useEffect(() => { if (car.brand) setAvailableModels(getModels(car.brand)); }, [car.brand]);
  useEffect(() => {
    if (car.brand && car.model) {
      const sizeInfo = getCarSize(car.brand, car.model);
      if (sizeInfo) setCar(prev => ({ ...prev, length: sizeInfo.length, width: sizeInfo.width, size: sizeInfo.size }));
    }
  }, [car.brand, car.model]);

  const loadHistory = async () => {
    const userId = user.id || user._id;
    setLoading(true);
    try {
      const data = await api.getUserHistory(userId);
      setHistory(data || []);
      const reviewsData = await api.getUserRatings(userId);
      setMyReviews(reviewsData || []);
    } catch (error) {
      setHistory([]);
      setMyReviews([]);
    }
    setLoading(false);
  };

  const onRefresh = async () => { setRefreshing(true); await loadHistory(); setRefreshing(false); };

  const handleSave = async () => {
    const result = await api.updateUser(user.id || user._id, { car, avatar, language: currentLang });
    if (result.success) {
      onUpdateUser({ ...user, car, avatar, language: currentLang });
      Alert.alert(L('success'), L('saved'));
    }
  };

  const handlePickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { Alert.alert(L('error'), 'Gallery access required'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.3, base64: true
    });
    if (!result.canceled && result.assets[0]) {
      setAvatar(`data:image/jpeg;base64,${result.assets[0].base64}`);
    }
  };

  const handleTopUp = () => Alert.alert('🚧 Coming Soon', 'Balance top-up will be available soon!');

  const handleShareReferral = async () => {
    try {
      await Share.share({
        message: `Join ParkBro - Parking Brotherhood! 🚗\n\nUse my referral code: ${user.referralCode}\n\nGet 70 bonus points instead of 50!\n\nDownload: https://park-bro.com`,
      });
    } catch (error) { console.log(error); }
  };

  const handleCopyReferral = () => {
    if (Clipboard.setString) Clipboard.setString(user.referralCode);
    Alert.alert('✅ Copied!', `Referral code ${user.referralCode} copied`);
  };

  const changeLanguage = async (lang) => {
    setCurrentLang(lang);
    await api.updateUser(user.id || user._id, { language: lang });
    onUpdateUser({ ...user, language: lang });
  };

  const getTransactionIcon = (type) => {
    const icons = { deposit: '💳', payment: '💸', earning: '💰', bonus: '🎁', commission: '🏦', cancellation: '❌', penalty: '⚠️', referral: '👥' };
    return icons[type] || '📝';
  };

  const translateDescription = (description, type) => {
    if (currentLang === 'ru') return description;
    const addressMatch = description.match(/: (.+)$/);
    const address = addressMatch ? addressMatch[1] : '';
    if (description.includes('Бронирование:')) return `Booking: ${address}`;
    if (description.includes('Заработок:')) return `Earnings: ${address}`;
    if (description.includes('Комиссия:')) return `Commission: ${address}`;
    if (description.includes('Бонус за регистрацию')) return 'Registration bonus';
    if (description.includes('Реферальный бонус')) return `Referral bonus`;
    return description;
  };

  const formatDate = (dateString) => new Date(dateString).toLocaleDateString(currentLang === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const L = (key) => t(key, currentLang);
  const renderStars = (rating) => { let stars = []; for (let i = 0; i < 5; i++) stars.push(i < Math.floor(rating) ? '⭐' : '☆'); return stars.join(''); };

  const renderPicker = (visible, onClose, title, data, onSelect, currentValue) => (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.pickerOverlay}>
        <View style={styles.pickerContainer}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose}><Text style={styles.pickerClose}>✕</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.pickerList}>
            {data.map((item, index) => (
              <TouchableOpacity key={index} style={[styles.pickerItem, currentValue === item && styles.pickerItemActive]} onPress={() => { onSelect(item); onClose(); }}>
                <Text style={[styles.pickerItemText, currentValue === item && styles.pickerItemTextActive]}>{item}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const currentContent = aboutTab === 'terms' ? termsContent[aboutLang] : privacyContent[aboutLang];

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.backBtn}><Text style={styles.backBtnText}>←</Text></TouchableOpacity>
        <Text style={styles.title}>{L('profile')}</Text>
        <TouchableOpacity onPress={handleSave} style={styles.saveBtn}><Text style={styles.saveBtnText}>{L('save')}</Text></TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4a5568']} />}>
        {/* Avatar */}
        <TouchableOpacity style={styles.avatarSection} onPress={handlePickImage}>
          {avatar ? <Image source={{ uri: avatar }} style={styles.avatar} /> : (
            <View style={styles.avatarPlaceholder}><Text style={styles.avatarText}>{user.name?.charAt(0)?.toUpperCase()}</Text></View>
          )}
          <Text style={styles.changePhotoText}>{L('change_photo')}</Text>
        </TouchableOpacity>

        <Text style={styles.userName}>{user.name}</Text>
        <Text style={styles.userEmail}>{user.email}</Text>
        
        <TouchableOpacity style={styles.ratingContainer} onPress={() => setShowReviews(true)}>
          <Text style={styles.ratingStars}>{renderStars(user.rating || 5)}</Text>
          <Text style={styles.ratingText}>{(user.rating || 5).toFixed(1)} ({user.ratingCount || 0} {currentLang === 'en' ? 'reviews' : 'отзывов'}) →</Text>
        </TouchableOpacity>

        {/* Balance */}
        <View style={styles.balanceCard}>
          <View>
            <Text style={styles.balanceLabel}>{L('points')}</Text>
            <Text style={styles.balanceValue}>💰 {user.balance}</Text>
          </View>
          <TouchableOpacity style={styles.topUpBtn} onPress={handleTopUp}><Text style={styles.topUpBtnText}>{L('top_up')}</Text></TouchableOpacity>
        </View>

        {/* Referral */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>👥 Referral Code</Text>
          <View style={styles.referralCard}>
            <Text style={styles.referralCode}>{user.referralCode || 'PBXXXXXX'}</Text>
            <View style={styles.referralButtons}>
              <TouchableOpacity style={styles.referralBtn} onPress={handleCopyReferral}><Text style={styles.referralBtnText}>📋 Copy</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.referralBtn, styles.referralBtnShare]} onPress={handleShareReferral}><Text style={[styles.referralBtnText, styles.referralBtnShareText]}>📤 Share</Text></TouchableOpacity>
            </View>
          </View>
          <Text style={styles.referralHint}>Share your code! They get 70 points, you get 20 points.</Text>
        </View>

        {/* Language */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{L('language')}</Text>
          <View style={styles.langButtons}>
            {languages.map((lang) => (
              <TouchableOpacity key={lang.code} style={[styles.langBtn, currentLang === lang.code && styles.langBtnActive]} onPress={() => changeLanguage(lang.code)}>
                <Text style={styles.langBtnText}>{lang.flag}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Car */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{L('my_car')}</Text>
          <TouchableOpacity style={styles.selector} onPress={() => setShowBrandPicker(true)}>
            <Text style={styles.selectorLabel}>{L('brand')}</Text>
            <Text style={styles.selectorValue}>{car.brand || L('select_brand')}</Text>
            <Text style={styles.selectorArrow}>▼</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.selector, !car.brand && styles.selectorDisabled]} onPress={() => car.brand && setShowModelPicker(true)} disabled={!car.brand}>
            <Text style={styles.selectorLabel}>{L('model')}</Text>
            <Text style={styles.selectorValue}>{car.model || L('select_model')}</Text>
            <Text style={styles.selectorArrow}>▼</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.selector} onPress={() => setShowYearPicker(true)}>
            <Text style={styles.selectorLabel}>{L('year')}</Text>
            <Text style={styles.selectorValue}>{car.year || L('select_year')}</Text>
            <Text style={styles.selectorArrow}>▼</Text>
          </TouchableOpacity>
          {car.size && (
            <View style={[styles.sizeInfo, { borderLeftColor: getSizeColor(car.size) }]}>
              <Text style={styles.sizeTitle}>{L('car_size')}</Text>
              <View style={styles.sizeRow}>
                <View style={[styles.sizeBadge, { backgroundColor: getSizeColor(car.size) }]}><Text style={styles.sizeBadgeText}>{car.size}</Text></View>
                <Text style={styles.sizeText}>{getSizeLabel(car.size, currentLang)}</Text>
              </View>
              <Text style={styles.sizeDimensions}>{car.length}m × {car.width}m ({(car.length * 3.281).toFixed(1)}ft × {(car.width * 3.281).toFixed(1)}ft)</Text>
            </View>
          )}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>{L('color')}</Text>
            <TextInput style={styles.input} value={car.color || ''} onChangeText={(v) => setCar({ ...car, color: v })} placeholder="White" placeholderTextColor="#999" />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>{L('plate')}</Text>
            <TextInput style={styles.input} value={car.plate || ''} onChangeText={(v) => setCar({ ...car, plate: v })} placeholder="A123BC" placeholderTextColor="#999" autoCapitalize="characters" />
          </View>
        </View>

        {/* History */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{L('history')}</Text>
          {loading ? <Text style={styles.emptyText}>{L('loading')}</Text> : history.length === 0 ? <Text style={styles.emptyText}>{L('no_history')}</Text> : (
            history.slice(0, 10).map((item, index) => (
              <View key={item._id || index} style={styles.historyItem}>
                <Text style={styles.historyIcon}>{getTransactionIcon(item.type)}</Text>
                <View style={styles.historyInfo}>
                  <Text style={styles.historyDesc} numberOfLines={2}>{translateDescription(item.description, item.type)}</Text>
                  <Text style={styles.historyDate}>{formatDate(item.createdAt)}</Text>
                </View>
                <Text style={[styles.historyAmount, item.amount >= 0 ? styles.positive : styles.negative]}>{item.amount >= 0 ? '+' : ''}{item.amount}</Text>
              </View>
            ))
          )}
        </View>

        {/* About Button */}
        <TouchableOpacity style={styles.aboutBtn} onPress={() => { setAboutLang(currentLang === 'uk' ? 'uk' : currentLang === 'es' ? 'es' : currentLang); setShowAbout(true); }}>
          <Text style={styles.aboutBtnText}>ℹ️ {currentLang === 'en' ? 'About ParkBro' : currentLang === 'ru' ? 'О ПаркБро' : currentLang === 'uk' ? 'Про ParkBro' : 'Acerca de ParkBro'}</Text>
        </TouchableOpacity>

        {/* Website Button */}
        <TouchableOpacity style={styles.websiteBtn} onPress={() => Linking.openURL('https://park-bro.com')}>
          <Text style={styles.websiteBtnText}>🌐 {currentLang === 'en' ? 'Visit Website' : currentLang === 'ru' ? 'Наш сайт' : currentLang === 'uk' ? 'Наш сайт' : 'Visitar sitio web'}</Text>
        </TouchableOpacity>

        <View style={{ height: 50 }} />
      </ScrollView>

      {/* Pickers */}
      {renderPicker(showBrandPicker, () => setShowBrandPicker(false), L('brand'), carBrands, (brand) => setCar({ ...car, brand, model: null, size: null, length: null, width: null }), car.brand)}
      {renderPicker(showModelPicker, () => setShowModelPicker(false), L('model'), availableModels, (model) => setCar({ ...car, model }), car.model)}
      {renderPicker(showYearPicker, () => setShowYearPicker(false), L('year'), generateYears(), (year) => setCar({ ...car, year }), car.year)}

      {/* About Modal */}
      <Modal visible={showAbout} animationType="slide">
        <View style={styles.aboutContainer}>
          <View style={styles.aboutHeader}>
            <Text style={styles.aboutTitle}>{currentContent.title}</Text>
            <TouchableOpacity onPress={() => setShowAbout(false)}><Text style={styles.aboutClose}>✕</Text></TouchableOpacity>
          </View>
          
          {/* Tab selector */}
          <View style={styles.tabSelector}>
            <TouchableOpacity style={[styles.tab, aboutTab === 'terms' && styles.tabActive]} onPress={() => setAboutTab('terms')}>
              <Text style={[styles.tabText, aboutTab === 'terms' && styles.tabTextActive]}>📜 {aboutLang === 'ru' ? 'Условия' : aboutLang === 'uk' ? 'Умови' : aboutLang === 'es' ? 'Términos' : 'Terms'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.tab, aboutTab === 'privacy' && styles.tabActive]} onPress={() => setAboutTab('privacy')}>
              <Text style={[styles.tabText, aboutTab === 'privacy' && styles.tabTextActive]}>🔒 {aboutLang === 'ru' ? 'Приватность' : aboutLang === 'uk' ? 'Приватність' : aboutLang === 'es' ? 'Privacidad' : 'Privacy'}</Text>
            </TouchableOpacity>
          </View>
          
          {/* Language selector */}
          <View style={styles.aboutLangSelector}>
            {['en', 'ru', 'uk', 'es'].map((lang) => (
              <TouchableOpacity key={lang} style={[styles.aboutLangBtn, aboutLang === lang && styles.aboutLangBtnActive]} onPress={() => setAboutLang(lang)}>
                <Text style={styles.aboutLangBtnText}>{lang === 'en' ? '🇺🇸' : lang === 'ru' ? '🇷🇺' : lang === 'uk' ? '🇺🇦' : '🇪🇸'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          
          <ScrollView style={{ flex: 1, padding: 20 }} showsVerticalScrollIndicator={true}>
            <View style={styles.aboutLogo}>
              <Text style={styles.aboutLogoEmoji}>🚗</Text>
              <Text style={styles.aboutLogoText}>ParkBro</Text>
              <Text style={styles.aboutLogoSubtext}>Parking Brotherhood</Text>
            </View>
            <Text style={styles.aboutVersion}>Version 2.0 • January 15, 2026</Text>
            
            {currentContent.sections.map((section, index) => (
              <View key={index} style={styles.aboutSection}>
                <Text style={styles.aboutSectionTitle}>{section.heading}</Text>
                <Text style={styles.aboutText}>{section.text}</Text>
              </View>
            ))}
            
            <View style={styles.aboutContact}>
              <Text style={styles.aboutContactTitle}>📧</Text>
              <Text style={styles.aboutContactEmail}>c110ko30rus@gmail.com</Text>
            </View>
            <Text style={styles.aboutCopyright}>© 2026 ParkBro LLC. All rights reserved.</Text>
            <View style={{height: 40}} />
          </ScrollView>
        </View>
      </Modal>

      {/* Reviews Modal */}
      <Modal visible={showReviews} animationType="slide">
        <View style={styles.reviewsContainer}>
          <View style={styles.reviewsHeader}>
            <Text style={styles.reviewsTitle}>{currentLang === 'en' ? 'My Reviews' : 'Мои отзывы'}</Text>
            <TouchableOpacity onPress={() => setShowReviews(false)}><Text style={styles.reviewsClose}>✕</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.reviewsContent}>
            {myReviews.length === 0 ? (
              <View style={styles.emptyReviews}>
                <Text style={styles.emptyReviewsIcon}>📝</Text>
                <Text style={styles.emptyReviewsText}>{currentLang === 'en' ? 'No reviews yet' : 'Пока нет отзывов'}</Text>
              </View>
            ) : myReviews.map((review, index) => (
              <View key={review._id || index} style={styles.reviewCard}>
                <View style={styles.reviewCardHeader}>
                  <Text style={styles.reviewCardStars}>{renderStars(review.rating)}</Text>
                  <Text style={styles.reviewCardDate}>{new Date(review.createdAt).toLocaleDateString()}</Text>
                </View>
                <Text style={styles.reviewCardFrom}>{currentLang === 'en' ? 'From: ' : 'От: '}{review.fromUserId?.name || 'Anonymous'}</Text>
                {review.comment && <Text style={styles.reviewCardComment}>"{review.comment}"</Text>}
              </View>
            ))}
            <View style={{height: 40}} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 60, paddingHorizontal: 20, paddingBottom: 20, backgroundColor: 'white' },
  backBtn: { padding: 10 },
  backBtnText: { fontSize: 24, color: '#333' },
  title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  saveBtn: { backgroundColor: '#4a5568', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  saveBtnText: { color: 'white', fontWeight: '600' },
  content: { flex: 1, padding: 20 },
  avatarSection: { alignItems: 'center', marginBottom: 15 },
  avatar: { width: 100, height: 100, borderRadius: 50 },
  avatarPlaceholder: { width: 100, height: 100, borderRadius: 50, backgroundColor: '#4a5568', justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 40, color: 'white', fontWeight: 'bold' },
  changePhotoText: { color: '#4a5568', marginTop: 10, fontSize: 14 },
  userName: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', color: '#333' },
  userEmail: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 5 },
  ratingContainer: { alignItems: 'center', marginBottom: 20 },
  ratingStars: { fontSize: 18 },
  ratingText: { fontSize: 14, color: '#666', marginTop: 3 },
  balanceCard: { backgroundColor: 'white', borderRadius: 15, padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 3 },
  balanceLabel: { fontSize: 14, color: '#666' },
  balanceValue: { fontSize: 28, fontWeight: 'bold', color: '#4a5568' },
  topUpBtn: { backgroundColor: '#4a5568', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  topUpBtnText: { color: 'white', fontWeight: 'bold' },
  section: { backgroundColor: 'white', borderRadius: 15, padding: 20, marginBottom: 20 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 15 },
  referralCard: { backgroundColor: '#f0f4f8', borderRadius: 12, padding: 15, alignItems: 'center' },
  referralCode: { fontSize: 28, fontWeight: 'bold', color: '#4a5568', letterSpacing: 3, marginBottom: 15 },
  referralButtons: { flexDirection: 'row', gap: 10 },
  referralBtn: { backgroundColor: 'white', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#4a5568' },
  referralBtnShare: { backgroundColor: '#4a5568' },
  referralBtnText: { color: '#4a5568', fontWeight: '600' },
  referralBtnShareText: { color: 'white' },
  referralHint: { fontSize: 12, color: '#666', marginTop: 10, textAlign: 'center' },
  langButtons: { flexDirection: 'row', justifyContent: 'space-between' },
  langBtn: { flex: 1, padding: 15, marginHorizontal: 4, borderRadius: 10, borderWidth: 2, borderColor: '#e0e0e0', alignItems: 'center' },
  langBtnActive: { borderColor: '#4a5568', backgroundColor: '#f0f4f8' },
  langBtnText: { fontSize: 24 },
  selector: { backgroundColor: '#f5f5f5', borderRadius: 10, padding: 15, marginBottom: 10, flexDirection: 'row', alignItems: 'center' },
  selectorDisabled: { opacity: 0.5 },
  selectorLabel: { fontSize: 12, color: '#999', position: 'absolute', top: 5, left: 15 },
  selectorValue: { flex: 1, fontSize: 16, color: '#333', marginTop: 10 },
  selectorArrow: { fontSize: 12, color: '#999' },
  sizeInfo: { backgroundColor: '#f8f9fa', borderRadius: 10, padding: 15, marginBottom: 15, borderLeftWidth: 4 },
  sizeTitle: { fontSize: 12, color: '#666', marginBottom: 8 },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sizeBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  sizeBadgeText: { color: 'white', fontWeight: 'bold', fontSize: 14 },
  sizeText: { fontSize: 16, fontWeight: '600', color: '#333' },
  sizeDimensions: { fontSize: 14, color: '#666', marginTop: 5 },
  inputGroup: { marginBottom: 15 },
  inputLabel: { fontSize: 14, color: '#666', marginBottom: 5 },
  input: { backgroundColor: '#f5f5f5', borderRadius: 10, padding: 15, fontSize: 16, color: '#333' },
  historyItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  historyIcon: { fontSize: 20, marginRight: 12 },
  historyInfo: { flex: 1 },
  historyDesc: { fontSize: 14, color: '#333' },
  historyDate: { fontSize: 12, color: '#999', marginTop: 2 },
  historyAmount: { fontSize: 16, fontWeight: 'bold' },
  positive: { color: '#4caf50' },
  negative: { color: '#f44336' },
  emptyText: { color: '#999', textAlign: 'center', padding: 20 },
  aboutBtn: { backgroundColor: 'white', borderRadius: 15, padding: 20, alignItems: 'center', marginBottom: 15 },
  websiteBtn: { backgroundColor: '#4a5568', borderRadius: 15, padding: 20, alignItems: 'center', marginBottom: 20 },
  websiteBtnText: { fontSize: 16, fontWeight: '600', color: 'white' },
  aboutBtnText: { fontSize: 16, color: '#4a5568', fontWeight: '600' },
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerContainer: { backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%' },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  pickerTitle: { fontSize: 18, fontWeight: 'bold' },
  pickerClose: { fontSize: 20, color: '#666' },
  pickerList: { padding: 10 },
  pickerItem: { padding: 15, borderRadius: 10 },
  pickerItemActive: { backgroundColor: '#f0f4f8' },
  pickerItemText: { fontSize: 16, color: '#333' },
  pickerItemTextActive: { color: '#4a5568', fontWeight: 'bold' },
  aboutContainer: { flex: 1, backgroundColor: '#f5f5f5', paddingTop: 50 },
  aboutHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 15, backgroundColor: '#f5f5f5' },
  aboutTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  aboutClose: { fontSize: 24, color: '#666', padding: 5 },
  tabSelector: { flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 10, gap: 10 },
  tab: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#e0e0e0', alignItems: 'center' },
  tabActive: { backgroundColor: '#4a5568' },
  tabText: { fontSize: 14, color: '#666', fontWeight: '600' },
  tabTextActive: { color: 'white' },
  aboutLangSelector: { flexDirection: 'row', justifyContent: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e0e0e0', backgroundColor: '#f5f5f5', gap: 10 },
  aboutLangBtn: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20, backgroundColor: '#e0e0e0' },
  aboutLangBtnActive: { backgroundColor: '#4a5568' },
  aboutLangBtnText: { fontSize: 20 },
  aboutLogo: { alignItems: 'center', marginBottom: 10, backgroundColor: 'white', borderRadius: 20, padding: 25 },
  aboutLogoEmoji: { fontSize: 60 },
  aboutLogoText: { fontSize: 36, fontWeight: 'bold', color: '#4a5568', marginTop: 10 },
  aboutLogoSubtext: { fontSize: 16, color: '#666', marginTop: 5 },
  aboutVersion: { textAlign: 'center', color: '#999', marginBottom: 20, fontSize: 14 },
  aboutSection: { backgroundColor: 'white', borderRadius: 15, padding: 20, marginBottom: 15 },
  aboutSectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#4a5568', marginBottom: 12 },
  aboutText: { fontSize: 14, color: '#555', lineHeight: 22 },
  aboutContact: { backgroundColor: '#4a5568', borderRadius: 15, padding: 20, alignItems: 'center', marginBottom: 15 },
  aboutContactTitle: { fontSize: 16, fontWeight: 'bold', color: 'white', marginBottom: 8 },
  aboutContactEmail: { fontSize: 16, color: 'rgba(255,255,255,0.9)' },
  aboutCopyright: { textAlign: 'center', color: '#999', fontSize: 12, marginTop: 10 },
  reviewsContainer: { flex: 1, backgroundColor: '#f5f5f5', paddingTop: 50 },
  reviewsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 15 },
  reviewsTitle: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  reviewsClose: { fontSize: 24, color: '#666', padding: 5 },
  reviewsContent: { flex: 1, padding: 20 },
  emptyReviews: { alignItems: 'center', padding: 40 },
  emptyReviewsIcon: { fontSize: 50, marginBottom: 15 },
  emptyReviewsText: { fontSize: 16, color: '#999' },
  reviewCard: { backgroundColor: 'white', borderRadius: 15, padding: 15, marginBottom: 12 },
  reviewCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  reviewCardStars: { fontSize: 16 },
  reviewCardDate: { fontSize: 12, color: '#999' },
  reviewCardFrom: { fontSize: 14, color: '#666', marginBottom: 5 },
  reviewCardComment: { fontSize: 15, color: '#333', fontStyle: 'italic', marginVertical: 8, lineHeight: 22 },
});

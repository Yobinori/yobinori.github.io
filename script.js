// 画像を切り替えるための画像URLのリスト
var imageUrls = [
  "images/takumi_6.jpg",
  "images/takumi_5.jpg"
];

// 画像を切り替える間隔（ミリ秒単位）
var interval = 2000;

// 画像を切り替える関数
function changeImage() {
  var image = document.getElementById("image-takumi");
  var currentIndex = imageUrls.indexOf(image.src);
  var nextIndex = (currentIndex + 1) % imageUrls.length;
  image.src = imageUrls[nextIndex];
}

// 一定の時間ごとに画像を切り替えるタイマーを設定
setInterval(changeImage, interval);
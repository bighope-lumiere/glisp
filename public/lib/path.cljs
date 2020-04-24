(load-file "math.cljs")

(defn path? [a] (and (sequential? a) (= :path (first a))))

;; Path modifiers

(defn path/map-points [f path]
  (vec
   (apply concat :path (map (fn [[cmd & points]] `(~cmd ~@(map f points)))
                            (path/split-segments path)))))



(defn path/translate [t path]
  (path/map-points #(vec2/+ % t) path))

(defn path/scale [s path]
  (path/map-points #(vec2/* % s) path))

(defn path/rotate [origin angle path]
  (path/map-points #(vec2/rotate origin angle %) path))

(defn path/merge [& xs]
  (vec (concat :path (apply concat (map rest xs)))))
